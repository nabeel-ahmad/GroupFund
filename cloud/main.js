var _ = require('underscore');
var moment = require('moment');
var config=require("cloud/config.js");
var util = require("cloud/util.js");
var enums = require("cloud/enum.js");
var balanced = require("cloud/balanced.js");
var payments = require("cloud/payments.js");
var notifications = require("cloud/notifications.js");
var Mandrill = require('mandrill');
var Buffer = require('buffer').Buffer;
require('cloud/app.js');

var Twilio = require('twilio');
Twilio.initialize(config.twilio.id, config.twilio.secret);
Mandrill.initialize(config.mandrillKey);


Parse.Cloud.beforeSave("Activity", function(request, response) {
	validation = util.validateRow(request, 
			["title", "amount", "type"], // required fields
			["raisedAmount", "status"], // read only fields
			["type"] // unchangeable fields
	);
	if(validation.valid) {		
		
		if(request.object.get("amount") < enums.min_trx || request.object.get("amount") > enums.max_goal) {
			response.error("Amount must be >= " + enums.min_trx + " cents and <= " + enums.max_goal + " cents");
			return;
		}
		
		validTypes = _.values(enums.type);
		if (validTypes.indexOf(request.object.get("type")) == -1) {
			response.error("Resource not found.");
			return;
		}
		
		if(request.object.isNew()) {
			if(!Parse.User.current() && !request.master) {
				response.error("Sign in required.");
				return;
			}

			request.object.set("status", enums.status.WAITING);
			request.object.set("contributionCount", 0);
			request.object.set("payoutStatus", enums.payout_status.NOT_STARTED);
			request.object.set("raisedAmount", 0);
			
			if (request.object.get("type") == enums.type.CROWD) {
				if (!request.object.get("endDate") || request.object.get("endDate") < new Date()) {
					response.error("End date is invalid.");
					return;
				}
			}
			
			if (request.object.get("type") == enums.type.PERSONAL) {
				response.success();
			} else {
				var acl = new Parse.ACL(Parse.User.current());
				acl.setPublicReadAccess(true);
				request.object.setACL(acl);
				request.object.set("owner", Parse.User.current());
				if(request.object.get("invitees")) {
					inviteUsers(request.object, request.object.get("invitees"), response);
				} else {
					response.success();
				}
			}
		} else {
			response.success();
		}
	} else {
		response.error(validation.message);
	}
});

Parse.Cloud.define("sendMoney", function(request, response) {
	Parse.Cloud.useMasterKey();
	util.startTimer(response, "sendMoney");
	if(!Parse.User.current()) {
		response.error("Sign in required.");
		return;
	}
	
	if(request.params.amount < enums.min_trx || request.params.amount > enums.max_trx) {
		response.error("Amount must be >= " + enums.min_trx + " cents and <= " + enums.max_trx + " cents");
		return;
	}
	
	var sender = Parse.User.current();
	
	var Activity = Parse.Object.extend("Activity");
	var activity = new Activity();
	_.each(_.keys(request.params), function(key) {
		activity.set(key, request.params[key]);
	});
	
	activity.set("type", enums.type.PERSONAL);
	var recepient = activity.get("recepient");
	if(!recepient)
		response.error("recepient is required");
	
	
	var setRecepient = function(recepient) {
		activity.set("owner", recepient);
		activity.set("sender", sender);
		acl = new Parse.ACL(recepient);
		acl.setPublicReadAccess(true);
		activity.setACL(acl);
		activity.save().then(function(activity) {
			var promises=[];
			promises.push(activity.get("sender").fetch());
			promises.push(activity.get("owner").fetch());
			Parse.Promise.when(promises).then(function(){
				var amount = activity.get("amount");
				var fee = payments.calculatePayerFee(amount);
				payments.saveTransaction(amount, fee, sender, activity, null, null, {
					success : function(trx) {
						notifications.notifyPaymentRecieved(activity).then(function(){
							response.success(activity);
						});
				},
				error : function(error) {
					response.error(error);
				}
				});
			});
			
		}, function(activity, error) {
			response.error(error);
		});
	};
	
	var addAnonymousUser = function() {
		if(!recepient.email) {
			response.error("Recipient email address is required.");
			return;
		}
			
		var user = new Parse.User();
		
		user.set("fname", recepient.fname);
		user.set("lname", recepient.lname);
		user.set("username", recepient.email);
		user.set("password", "anp"+util.guid());
		user.set("anonymous", true);
		user.set("email", recepient.email);
		user.signUp(null, {
			success : setRecepient,
			error : function(user, error) {
				response.error(error.message);
			}
		});
	};
	
	var query = new Parse.Query("UserSettings");
	query.equalTo("owner", Parse.User.current());
	query.exists("creditCard");
	query.count({
		success : function(count) {
			if(count > 0) {
				if(recepient.email) {
					var query = new Parse.Query(Parse.User);
					query.equalTo("email", recepient.email);
					query.first().then(function(recepient) {
						if(recepient)
							setRecepient(recepient);
						else
							addAnonymousUser();
					}, addAnonymousUser);
				} else {
					response.error("Invalid Recipient.");
				}
			} else {
				response.error("User does not have a Credit Card on file.");
			}
		}
	});
	
});

Parse.Cloud.afterSave("Activity", function(request){
	
	if(!request.object.existed()){
		
		if(request.object.get("type") == enums.type.GROUP) {
			var owner=request.object.get("owner");
			owner.fetch().then(function(owner){
				notifications.notifyInvitations(request.object,owner,{
					success : function(){
						console.log("notification sent");
					},
					error : function(error){
						console.log(error);
					}
				});
			},
			function(error){
				throw exception.error(error);
			});
		}
	}
});

function inviteUsers(activity, invitees, options) {
	Parse.Cloud.useMasterKey();
	if(invitees.length > enums.max_payments) {
		options.error("You have exceeded the maximum number of Friends that can be added to a Split Expense. Sorry for the inconvenience.");
		return;
	}
	
	var Invitation = Parse.Object.extend("Invitation");
	
	var inviteEmails = [];
	var invitePhones = [];
	var inviteeMap = {};
	
	// Separate invitees into email and phone number groups
	_.each(invitees, function(invitee) {
		if(invitee.email) {
			inviteEmails.push(invitee.email);
			inviteeMap[invitee.email] = invitee;
		} else if(invitee.phoneNumber) {
			invitePhones.push(invitee.phoneNumber);
			inviteeMap[invitee.phoneNumber] = invitee;
		}
	});
	
	var invitations = [];
	var processed = 0;
	var invitationCount = 0;
	
	var callback = function(user, invitee) {
		inv = new Invitation();
		if(user) {
			inv.set("user", user);
			inv.set("userId", user.id);
		} 
		inv.set("invitee", invitee);
		inv.set("status", enums.status.INVITATION.PENDING);
		
		var acl = new Parse.ACL();
		acl.setPublicReadAccess(true);
		inv.setACL(acl);
		inv.save().then(function(inv) {
			processed++;
			
			invitations.push(inv);
			if(processed == invitationCount) {
				var relation = activity.relation("invitations");
				relation.add(invitations);
				activity.unset("invitees");
				options.success();
			}
		}, function(inv, error) {
			options.error(error);
		});
	};
	
	// Fetch users already registered with the given emails or phone numbers
	var emailQuery = new Parse.Query(Parse.User);
	emailQuery.containedIn("email", inviteEmails);
	emailQuery.include("settings");
	
	var innerQuery = new Parse.Query("UserSettings");
	innerQuery.containedIn("phone", invitePhones);
	innerQuery.equalTo("phoneVerified", true);
	
	var phoneQuery = new Parse.Query(Parse.User);
	phoneQuery.matchesKeyInQuery("objectId", "ownerId", innerQuery);
	phoneQuery.include("settings");
	
	var mainQuery = Parse.Query.or(emailQuery, phoneQuery);
	mainQuery.include("settings");
	mainQuery.find().then(function(registeredUsers) {
		
		// Add invitations for registered users
		_.each(registeredUsers, function(user) {
			var invitee = inviteeMap[user.get("email")];
			if(!invitee)
				invitee = inviteeMap[user.get("settings").get("phone")];
			delete inviteeMap[user.get("email")];
			delete inviteeMap[user.get("settings").get("phone")];
			if(invitee) {
				callback(user, invitee);
			}
		});
		
		invitationCount = registeredUsers.length;
		// Add anonymous users for the remaining invitees who are not registered users
		_.each(_.values(inviteeMap), function(invitee) {
			invitationCount++;
			callback(null, invitee);
		});
	}, function(error) {
		options.error(error);
	});
}

Parse.Cloud.define("addMerchantAccount", function(request, response) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("BalancedCustomer");
	query.equalTo("owner", Parse.User.current());
	query.first().then(function(acct) {
		if(acct) {
			payments.associateBankAccount2Account(request.params.bankAccount, acct, request.params.merchant, {
				success: function(msg) {
					response.success("Bank account added successfully");
				},
				error: response.error
			});
		} else {
			response.error("Resource not found.");
		}
	},
	response.error
	);
});

Parse.Cloud.define("deleteBankAccount", function(request, response) {
		payments.deleteBankAccount(response);
});

function sendPushNotification(subject,recepients, activityId, pushData){
	if(recepients && recepients.length > 0) {
		 var query = new Parse.Query(Parse.Installation);
		 query.containedIn("owner", recepients);
		 if(subject.length > 255)
			 subject = subject.substring(0, 252) + "...";
		 var data = {
			      alert:subject,
			      activityId : activityId
			    };
		 _.extend(data, pushData);
		 Parse.Push.send({
			    where: query, 
			    data: data
			  }, {
			    success: function() {},
			    error: function(error) {
			      throw "Got an error " + error.code + " : " + error.message;
			    }
		});	 
	}
}

Parse.Cloud.afterSave("Notification", function(request) {
	
	
	var _apiUrl = 'mandrillapp.com/api/1.0';
	var emailRecepients = [];
	var emailInfo=[];
	
	emailInfo = request.object.get("emailInfo");
	emailRecepients = request.object.get("emailRecepients");
	var templateName = request.object.get("templateName");
	var subject=request.object.get("subject");
	var activityId=request.object.get("activityId");
	sendPushNotification(subject,request.object.get("pushRecepients"),activityId, request.object.get("pushData"));
	
	var params = {
			key : enums.mandrill.password,
			template_name : templateName,
			template_content : [],
			message : {
				merge : true,
				global_merge_vars :emailInfo,
				subject : subject,
				from_email : "support@groupfundapp.co",
				from_name : "GroupFund",
				to : emailRecepients
			},
			async : true
			
		};
		params = JSON.stringify(params);

		Parse.Cloud.httpRequest({
			method : 'POST',
			headers : {
				'Content-Type' : 'application/json',
			},
			url : 'https://' + _apiUrl
					+ '/messages/send-template.json',
			body : params,
			success : function() {
	
				console.log("Email Sent");
			},
			error : function(error) {
				console.log(error.message);
			}

		});
});

Parse.Cloud.define("invalidateCreditCard", function(request, response) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Transaction");
	query.equalTo("owner", Parse.User.current());
	query.equalTo("status", enums.status.PENDING);
	query.count().then(
		function(count) {
			if(count == 0)
				payments.invalidateCreditCard(response);
			else
				response.error("Credit Card cannot be removed at this time because you have one or more pending payments, which means those payments have been not collected by the receivers. If you like to delete this card, you can cancel those payments and try again. Alternatively, please ask the receivers to collect your pending payments and afterwards, you can delete this Credit Card.");
	}, response.error);	
});

Parse.Cloud.define("addCreditCard", function(request, response) {
	if (!Parse.User.current()) {
		response.error("Sign in required.");
		return;
	}
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("BalancedCustomer");
	
	query.equalTo("owner", Parse.User.current());
	query.first({
		success : function(result) {
			if(result) {
				payments.associateCard2Account(request.params, Parse.User.current(), result.get("uri"), {
					success: function(msg) {
						response.success(msg);
					},
					error: response.error
				});
			} else {
				response.error("User's balanced payment account not found.");			
			}
		},
		error : response.error
	});
});



Parse.Cloud.define("contribute", function(request, response) {
	Parse.Cloud.useMasterKey();
	if(request.params.amount < enums.min_trx || request.params.amount > enums.max_trx) {
		response.error("Amount must be >= " + enums.min_trx + " cents and <= " + enums.max_trx + " cents");
		return;
	}
	
	var promises = [];
	var voucher = null;
	var activity = null;
	var creditCardCount = 0;
	
	if(request.params.voucherId && Parse.User.current()) {
		var query = new Parse.Query("Voucher");
		query.equalTo("owner", Parse.User.current());
		query.equalTo("used", false);
		query.greaterThan("expiresOn", new Date());
		promises.push(query.get(request.params.voucherId, {
			success: function(result) {
				voucher = result;
			}
		}));
	}
	
	var query = new Parse.Query("Activity");
	query.include("owner");
	query.equalTo("status", enums.status.WAITING);
	promises.push(query.get(request.params.activityId, {
		success: function(result) {
			activity = result;
		}
	}));
	
	if(Parse.User.current()) {
		var query = new Parse.Query("UserSettings");
		query.equalTo("owner", Parse.User.current());
		query.exists("creditCard");
		promises.push(query.count({
			success : function(result) {
				creditCardCount = result;
			}
		}));
	}
	
	Parse.Promise.when(promises).then(function() {
		
		var fee = 0;
		if(!voucher) {
			fee = payments.calculatePayerFee(request.params.amount);
			if(request.params.fee != fee) {
				response.error("Incorrect fee.");
				return;
			}
		}
	
		if(activity.get("endDate") && activity.get("endDate") < new Date()) {
			response.error("Activity has expired.");
			return;
		}
		if(activity.get("type") == enums.type.PERSONAL) {
			// Only one contribuition is allowed for send money use case
			response.error("Invalid resource request.");
			return;
		}
		if(activity.get("contributionCount") >= enums.max_payments) {
			response.error("Due to security and performance reasons, the activity cannot take in any more contributions. Sorry for the inconvenience.");
			return;
		}
		
		if (!Parse.User.current()) {
			if(!request.params.card) {
				response.error("Invalid Credit Card.");
				return;
			}
    		// Save contribution from anonymous user
			if(request.params.invitationId) {
				query = activity.relation("invitations").query();
				query.equalTo("status", enums.status.INVITATION.PENDING);
				query.doesNotExist("user");
				query.get(request.params.invitationId).then(function(invitation) {
					if(request.params.amount != invitation.get("invitee").amount) {
						response.error("Invalid amount.");
					} else {
						getAnonymousUser(request.params.email, request.params.name, request.params.card, {
		    				success : function(user) {
		    					payments.saveTransaction(request.params.amount, fee, user, activity, invitation, voucher, response);
		    				},
							error : response.error
		    			});
					}
				}, function() {
					response.error("Resource not found.");
				});
			} else if(activity.get("type") == enums.type.CROWD) {
				getAnonymousUser(request.params.email, request.params.name, request.params.card, {
    				success : function(user) {
    					payments.saveTransaction(request.params.amount, fee, user, activity, null, voucher, response);
    				},
					error : response.error
    			});
			} else {
				response.error("Resource not found.");
			}
		} else {
				if(creditCardCount > 0) {
					if(activity.get("type") == enums.type.GROUP) {
						query = activity.relation("invitations").query();
						query.equalTo("user", Parse.User.current());
						query.equalTo("status", enums.status.INVITATION.PENDING);
						query.include("user");
						query.first().then(function(invitation) {
							if(invitation) {
								if(request.params.amount != invitation.get("invitee").amount) {
									response.error("Invalid amount.");
								} else {
									payments.saveTransaction(request.params.amount, fee, Parse.User.current(), activity, invitation, voucher, response);
								}
							} else {
								response.error("Resource not found. ");
							}
						}, function() {
							response.error("Resource not found.");
						});
					} else {
						payments.saveTransaction(request.params.amount, fee, Parse.User.current(), activity, null, voucher, response);
					}
				} else {
					response.error("User does not have a Credit Card on file.");
				}
		}										
	}, response.error);
});

function addCard(user, card, options) {
	if(!card)
		options.success(user);
	else {
		var query = new Parse.Query("BalancedCustomer");
		query.equalTo("owner", user);
		query.first().then(function(acct) {
			if(acct) {
				payments.associateCard2Account(card, user, acct.get("uri"), {
					success : function() {
						options.success(user);
					},
					error : options.error
				});
			}
			else
				options.error("User account not found.");
		},
		options.error);
	}
}

function getAnonymousUser(email, name, card, options) {
	if(!email) {
		options.error("Email must be provided.");
		return;
	}
	
	var query = new Parse.Query("User");
	query.equalTo("email", email);
	query.equalTo("anonymous", true);
	query.first().then(
			function(user) {
				if(user) {
					// Anonymous user with given email already exists
					addCard(user, card, options);
				}
				else {
					// Add new anonymous user
					var user = new Parse.User();
					
					var nameArr = name.split(" ");
					
					user.set("fname", nameArr[0]);
					user.set("lname", nameArr[nameArr.length-1]);
					user.set("username", email);
					user.set("password", "anp"+util.guid());
					user.set("anonymous", true);
					user.set("email", email);
					user.signUp(null, {
						success : function(user) {
							addCard(user, card, options);
						},
						error : function(user, error) {
							options.error(error.message);
						}
					});
				}
			}, 
		options.error
	);
}

Parse.Cloud.define("cancelTransaction", function(request, response) {
	payments.cancelTransaction(request.params.trId, response);			
});

Parse.Cloud.define("collectAndClose", function(request, response) {
	payments.fundActivity(request.params.activityId, request.params.voucherId, request.params.appVersion, response);
});

Parse.Cloud.define("payMerchant", function(request, response) {
	// This has to be called on success of collectAndClose. 
	// It must be done in a separate call to avoid Parse timeout
	var currentUser = Parse.User.current();
	if(request.master && !currentUser) {
		// Version 1.0.4 and above
		var userId = request.params.userId;
		var query = new Parse.Query(Parse.User);
		query.get(userId).then(function(user) {
			payments.payMerchant(request.params.activityId, request.params.voucherId, user, response);
		}, response.error);
	} else if(currentUser){
		// For version 1.0.3
		payments.payMerchant(request.params.activityId, request.params.voucherId, currentUser, response);
	} else {
		response.error("Invalid request.");
	}
});

Parse.Cloud.define("cancelActivity", function(request, response) {
	payments.cancelActivity(request.params.activityId, response);
});

Parse.Cloud.job("runScheduledTasks", function(request, response) {
	var taskCount = 2;
	var tasksRun = 0;
	var result = "all tasks run successfully";
	var options = {
		success : function() {
			tasksRun++;
			if (tasksRun == taskCount)
				response.success(result);
		},
		error : function(error) {
			console.error(error);
			result = "some tasks failed";
			tasksRun++;
			if (tasksRun == taskCount)
				response.success(result);
		}
	};
	
	payments.processExpiredActivities(options);
	payments.updatePayoutStatus(options); 
});

Parse.Cloud.job("collectFees", function(request, response) {
	var taskCount = 2;
	var tasksRun = 0;
	var result = "all tasks run successfully";
	var options = {
		success : function() {
			tasksRun++;
			if (tasksRun == taskCount)
				response.success(result);
		},
		error : function(error) {
			console.error(error);
			result = "some tasks failed";
			tasksRun++;
			if (tasksRun == taskCount)
				response.success(result);
		}
	};
	
	payments.collectPaymentFees(options);
	payments.collectPayoutFees(options);
});

Parse.Cloud.define("getReferenceData", function(request, response) {
	var refData = {
		balanced_marketplace_uri: balanced.getMarketplaceUri() 
	};
	refData = _.extend(refData, enums.fees);
	refData.max_payments = enums.max_payments;
	refData.activityURL = enums.baseURL + "/activity?id=<id>";
	response.success(refData);
});


Parse.Cloud.define("getActivityDetails", function(request, response) {
	if (!Parse.User.current()) {
		response.error("Sign in required.");
		return;
	}
	Parse.Cloud.useMasterKey();
	var result = {};
	var permission = false;
	var query = new Parse.Query("Activity");
	query.include("owner");
	query.include("sender");
	query.get(request.params.activityId).then(
		function(activity) {
			if(activity.get("type") == enums.type.CROWD)
				permission = true;
			else if(activity.get("owner").id == Parse.User.current().id)
				permission = true;
			else if(activity.get("sender") && activity.get("sender").id == Parse.User.current().id)
				permission = true;
			result.activity = activity;
			query = new Parse.Query("Transaction");    
		    query.equalTo("activity", activity);
		    query.include("owner");
		    query.find().then(
		    	function(transactions) {
		    		result.transactions = transactions;
		    		
		    		var rel = activity.relation("invitations");
		    		query = rel.query();
		    		query.include("user");
		    		query.include("transaction");
		    		query.find().then(function(invitations) {
		    			
		    			if(permission == false) {
			    			_.each(invitations, function(inv) {
								if(inv.get("user") && inv.get("user").id == Parse.User.current().id)
									permission = true;
							});
			    		}
		    			
						result.invitations = invitations;
		    			
						if(permission)
							response.success(result);
						else
							response.error("Unauthorized.");
					}, response.error);
		    	},
		    	response.error
		    );
		},
		response.error
	);
});

Parse.Cloud.beforeSave("UserSettings", function(request, response) {
	validation = util.validateRow(request, 
			[], // required fields
			["creditCard", "bankAccount", "merchant", "phoneVerified"] // read only fields
	);
	if(validation.valid) {
		if(request.object.dirty("phone")) {
			request.object.set("phoneVerified", false);
			if(request.object.get("phone") && !request.object.isNew()) // isNew condition is to avoid sending verification code to users invited by phone number
				generatePhoneVerification(request.object.get("phone"), response);
			else
				response.success();
		} else {
			response.success();
		}
	} else {
		response.error(validation.message);
	}
});

Parse.Cloud.afterSave("Transaction", function(request) {
	Parse.Cloud.useMasterKey();
	if(request.object.existed()) {
		if(request.object.get("status") == enums.status.FAILED) {
			var promises = [];
			var activity = null;
			var query = new Parse.Query("Activity");
			query.include("owner");
			promises.push(query.get(request.object.get("activity").id, {
				success : function(result) {
					activity = result;
				}
			}));
			promises.push(request.object.fetch("owner"));
			Parse.Promise.when(promises).then(function() {
				notifications.notifyTrxFailureOrganizer(request.object, activity);
			});
		} 
	} 
});

Parse.Cloud.afterSave("_User", function(request) {
	if(request.object.existed()) {
		// Only manipulate new user objects
		return;
	}
	Parse.Cloud.useMasterKey();
	var UserSettings = Parse.Object.extend("UserSettings");
	var settings = new UserSettings();
	if(request.object.get("phone")) {
		settings.set("phone", request.object.get("phone"));
		request.object.unset("phone");
	}
	settings.set("phoneVerified", false);
	settings.set("owner", request.object);
	settings.set("ownerId", request.object.id);
	var acl = new Parse.ACL(request.object);
	settings.setACL(acl);
	settings.save().then(function(settings) {
		request.object.set("settings", settings);
		request.object.save();
	}, function(error) {
		throw error.message;
	});
	payments.addNewAccount(request.object, {
		success: function(account) {},
		error: function(error) {
			throw error.message;
		}
	});
	claimInvitations(request.object);
	if(!request.object.get("anonymous"))
		updateFriendInvitations(request.object);
});

function claimInvitations(user) {
	var query = new Parse.Query("Invitation");
	query.equalTo("invitee.email", user.get("email"));
	query.doesNotExist("user");
	
	query.collection().fetch().then(function(invitations) {
		invitations.each(function(inv) {
			inv.set("user", user);
			inv.set("userId", user.id);
			inv.save();
		});
	});
}

function updateFriendInvitations(user) {
	var query = new Parse.Query("FriendInvitation");
	query.equalTo("email", user.get("email"));
	query.include("owner");
	
	query.first().then(function(inv) {
		if(inv) {
			mixPanelInvitationAccepted(user);
			
			query = new Parse.Query("Voucher");
			query.equalTo("owner", inv.get("owner"));
			query.count().then(function(count) {
				// Only grant voucher to inviter once
				if(count == 0) {
					var Voucher = Parse.Object.extend("Voucher");
					var voucher = new Voucher();
					voucher.set("owner", inv.get("owner"));
					voucher.set("expiresOn", moment().add("years", 1).toDate());
					voucher.set("used", false);
					voucher.set("promoTitle", "Promo - " + inv.get("email"));
					var acl = new Parse.ACL();
					acl.setReadAccess(inv.get("owner").id, true);
					voucher.setACL(acl);
					voucher.save();
					notifications.notifyVocucherGranted(voucher, user);
				}
			});
		}
	});
}

function mixPanelInvitationAccepted(user) {
	// Register mixpanel user
	var data={
			$token: config.mixPannel.key,
			$distinct_id: user.get("email"),
			$set:{
				$email: user.get("email"),
				$name:util.getUserName(user),
				$firstname:user.get("fname"),
				$lastname:user.get("lname")
			}
	};

	var buf = new Buffer(JSON.stringify(data));
    var encoded=buf.toString('base64');
	var url="http://api.mixpanel.com/engage/?data="+encoded;
	Parse.Cloud.httpRequest({
		method : 'GET',
		url : url,
		success : function(httpResponse) {
		},
		error : function(httpResponse) {
			console.error("MixPanel : inviteAccept request failed.");
		}
	});
	
	// Track invitation accepted event
	var data={
			event:"inviteAccept",
			properties : {
				token: config.mixPannel.key,
				distinct_id: user.get("email"),
			}
	};

	var buf = new Buffer(JSON.stringify(data));
    var encoded=buf.toString('base64');
	var url="http://api.mixpanel.com/track/?data="+encoded;
	Parse.Cloud.httpRequest({
		method : 'GET',
		url : url,
		success : function(httpResponse) {
		},
		error : function(httpResponse) {
			console.error("MixPanel : inviteAccept request failed.");
		}
	});
}

function claimPhoneInvitations(user, phone) {
	var query = new Parse.Query("Invitation");
	query.equalTo("invitee.phoneNumber", phone);
	query.doesNotExist("user");
	
	var promises = [];
	query.collection().fetch().then(function(invitations) {
		invitations.each(function(inv) {
			inv.set("user", user);
			inv.set("userId", user.id);
			promises.push(inv.save());
		});
		return Parse.Promise.when(promises);
	});	
}

Parse.Cloud.define("generatePhoneVerification", function(request, response) {
	var query = new Parse.Query("UserSettings");
	query.equalTo("owner", Parse.User.current());
	query.select("phone");
    query.first({
    	 success : function(settings) {
    		 if(settings)
    			 generatePhoneVerification(settings.get("phone"), response);
    		 else
    			 response.error("Resource not found.");
    	 },
    	 error : response.error
    });
});

function generatePhoneVerification(phone, options) {
	Parse.Cloud.useMasterKey();
    if(phone) {
    	var code = _.random(100000, 999999).toString();
    	PhoneVerifCode = Parse.Object.extend("PhoneVerifCode");
    	pvc = new PhoneVerifCode();
    	pvc.set("code", code);
    	pvc.set("owner", Parse.User.current());
    	var acl = new Parse.ACL();
		pvc.setACL(acl);
    	pvc.save().then(function(){
    		Twilio.sendSMS({
    			  From: enums.twilio_sender,
    			  To: phone,
    			  Body: "GroupFund Mobile Phone Verification Code: " + code
    			}, {
    			  success: function(httpResponse) {
    			    console.log(httpResponse.data);
    			    options.success();
    			  },
    			  error: function(httpResponse) {
    			    console.error(httpResponse.data);
    			    options.error("Failed to send a txt message. Reason: " + httpResponse.data.message);
    			  }
    			});
    	}, 
    	options.error);
    } else {
    	options.error("Phone Number is not valid");
    }
}

Parse.Cloud.define("verifyPhone", function(request, response) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("PhoneVerifCode");
	query.equalTo("owner", Parse.User.current());
	query.descending("createdAt");
	query.first({
		success : function(pvc) {
			if(pvc && pvc.get("code") == request.params.code) {
				createdAt = moment(pvc.get("createdAt"));
				min = moment().subtract('days', 1);
				if(createdAt < min){
					response.error("verification code expired");
					return;
				}					
				
				var query = new Parse.Query("UserSettings");
				query.equalTo("owner", Parse.User.current());
			    query.first({
			        success : function(settings) {
			            if(settings) {
			            	var promises = [];
			            	settings.set("phoneVerified", true);
			            	promises.push(pvc.destroy());
			            	promises.push(settings.save());

			            	// Remove phone number from all other user accounts with the same phone to avoid duplicate numbers
			            	query = new Parse.Query("UserSettings");
			            	query.equalTo("phone", settings.get("phone"));
			            	query.notEqualTo("objectId", settings.id);
			            	query.collection().fetch().then(function(oldRows) {
			            		oldRows.each(function(row) {
									row.unset("phone");
									row.set("phoneVerified", false);
									promises.push(row.save());
								});
			            		promises.push(claimPhoneInvitations(Parse.User.current(), settings.get("phone")));
			            		Parse.Promise.when(promises).then(function(){
			            			response.success(settings);
			            		}, response.error);
			            		
							}, response.error);
			            	
			            } else {
			            	response.error("Resource not found.");
			            }
			        },
			        error : response.error
			    });	
			}
			else
				response.error("code incorrect");
		},
		error : response.error
	});	
});

Parse.Cloud.define("home", function(request, response) {
	Parse.Cloud.useMasterKey();
	var ownerQuery = new Parse.Query("Activity");
	ownerQuery.equalTo("owner", Parse.User.current());
	ownerQuery.descending("createdAt");

	var contributorQuery = new Parse.Query("Activity");
	var trxQuery = new Parse.Query("Transaction");
	trxQuery.equalTo("owner", Parse.User.current());
	contributorQuery.matchesKeyInQuery("objectId", "activityId", trxQuery);
	
	contributorQuery.descending("createdAt");

	var innerQuery = new Parse.Query("Invitation");
	innerQuery.equalTo("user", Parse.User.current());
	var invitedQuery = new Parse.Query("Activity");
	invitedQuery.matchesQuery("invitations", innerQuery);
	invitedQuery.descending("createdAt");
	
	var mainQuery = Parse.Query.or(ownerQuery, invitedQuery, contributorQuery);
	if(request.params.tab == 'active')
		mainQuery.equalTo("status", enums.status.WAITING);
	else 
		mainQuery.notEqualTo("status", enums.status.WAITING);
	mainQuery.include("owner");
	mainQuery.include("sender");
	mainQuery.descending("createdAt");
	mainQuery.count().then(function(count) {
		mainQuery.limit(enums.page_size);
		if(request.params.page)
			mainQuery.skip(enums.page_size * (request.params.page-1));
		mainQuery.find().then(function(activities) {
			var result = {
					activities : activities,
					count : count,
					pages : Math.ceil(count/enums.page_size),
					currentPage: request.params.page
				};
			response.success(result);
		}, response.error);	
	}, response.error);
});

Parse.Cloud.define("sendReminder", function(request, response) {	
	if(!Parse.User.current()) {
		response.error("Sign in required.");
		return;
	}
	var options={
		success : function(){
			response.success("Reminder sent to the pending payers.");
		},
		error : function(error){
			response.error(error);
		} 
	};
	var activityId = request.params.activityId;
	if(activityId) {
		var query = new Parse.Query("Activity");
		query.include("owner");
		query.include("sender");
		
		query.get(activityId, {
			success : function(activity) {
				if(activity.get("type") == enums.type.PERSONAL) {
					if(activity.get("sender").id == Parse.User.current().id) {
						
						var promise;
						if(activity.get("owner").get("email")){
							
							promise=notifications.reminderEmail(activity);
							promise.then(function(){
							response.success("Reminder has been sent.");
								
							});
							
						}else if(activity.get("recepient").phoneNumber){
							
							sms=util.getUserName(activity.get("sender"))+" sent you a reminder to collect the payment of $"+(activity.get("amount")/100)+" for "+util.truncateTitle(activity.get("title"));
							Twilio.sendSMS({
				    			  From: enums.twilio_sender,
				    			  To: activity.get("recepient").phoneNumber,
				    			  Body: sms
				    			}, {
				    			  success: function(httpResponse) {
				    				  response.success("A reminder SMS has been sent.");
				    			  },
				    			  error: function(httpResponse) {
				    				  response.error();
				    			  }
				    			});
						}
							
					} else
						response.error("Unauthorized");
				} else if(activity.get("owner").id == Parse.User.current().id) {
					var rel = activity.relation("invitations");
		    		query = rel.query();
		    		query.equalTo("status", enums.status.INVITATION.PENDING);
		    		query.include("user");
		    		query.collection().fetch({
		    				success : function(invitations) {
		    				if(invitations.length == 0){
		    					response.success("No one left to send a reminder.");
		    					return;
		    				} else
		    				notifications.notifyPendingPayments(invitations,activity,options);
			    		},
			    		error : response.error
		    		});
				} else {
					response.error("Unauthorized");
				}
			},
			error : response.error
		});
	} else {
		response.error("Resource not found.");
	}
});

Parse.Cloud.define("addPromoVoucher", function(request, response) {
	if(!Parse.User.current()) {
		response.error("Sign in required.");
		return;
	}
	Parse.Cloud.useMasterKey();
	var code = request.params.code;
	var query = new Parse.Query("Promo");
	query.equalTo("code", code);
	query.greaterThan("expiresOn", new Date());
	query.greaterThan("vouchersRemaining", 0);
	
	var innerQuery = new Parse.Query("Voucher");
	innerQuery.equalTo("owner", Parse.User.current());
	
	query.doesNotMatchKeyInQuery("objectId", "promoId", innerQuery); // One user cannot use a promo code more than once
	query.first().then(function(promo) {
		if(promo) {
			var promises = [];
			promo.increment("vouchersRemaining", -1);
			promises.push(promo.save());
			
			var Voucher = Parse.Object.extend("Voucher");
			var voucher = new Voucher();
			voucher.set("promo", promo);
			voucher.set("promoId", promo.id);
			voucher.set("promoTitle", promo.get("title"));
			voucher.set("owner", Parse.User.current());
			voucher.set("expiresOn", moment().add("years", 1).toDate());
			voucher.set("used", false);
			var acl = new Parse.ACL();
			acl.setReadAccess(Parse.User.current().id, true);
			voucher.setACL(acl);
			promises.push(voucher.save(null, {
				success: function(result) {
					voucher = result;
				}
			}));
			Parse.Promise.when(promises).then(function() {
				response.success(voucher);
			}, response.error);			
		} else {
			response.error("Invalid Promo Code or Promo Code is already in use.");
		}
	}, response.error);	
});

Parse.Cloud.define("inviteFriends", function(request, response) {
	Parse.Cloud.useMasterKey();
	if(!Parse.User.current()) {
		response.error("Sign in required.");
		return;
	}
	var promises = [];
	if(request.params.emails) {
		var FriendInvitation = Parse.Object.extend("FriendInvitation");
		
		_.each(request.params.emails, function(email) {
			var inv = new FriendInvitation();
			inv.set("email", email);
			inv.set("owner", Parse.User.current());
			promises.push(inv.save());
		});
		promises.push(notifications.inviteToApp(request.params.emails, Parse.User.current()));
		Parse.Promise.when(promises).then(function() {
			response.success("Invitations sent.");
		}, response.error);
	}
	else
		response.error("Invalid request.");
});

Parse.Cloud.job("migrateToCustomers", function(request, options) {
	var baseUrl = 'https://'+config.marketPlace.secret+'@api.balancedpayments.com';
	Parse.Cloud.useMasterKey();
	
	var query = new Parse.Query("BalancedAccount");
	query.doesNotExist("migrated");
	query.include("owner");
	query.limit(10);
	query.collection().fetch().then(function(accounts) {
		
		if(accounts.length == 0)
			options.success("Nothing to migrate");
		
		var processed = 0;
		var callback = function() {
			processed++;
			if(processed == accounts.length) {
				options.success("Migration complete");
			}
		};
		
		accounts.each(function(account) {
			balanced.getCredit(account.get("uri"), {
				success : function(accountObj) {
					var Customer = Parse.Object.extend("BalancedCustomer");
					var customer = new Customer();
					customer.set("uri", accountObj.customer_uri);
					customer.set("owner", account.get("owner"));
					customer.set("isMerchant", account.get("isMerchant"));
					customer.set("credits_uri", accountObj.customer_uri + "/credits");
					customer.setACL(new Parse.ACL());
					account.set("migrated", true);
					
					Parse.Cloud.httpRequest({
						  method: 'PUT',
						  url: baseUrl + accountObj.customer_uri,
						  body: {
								name: util.getUserName(account.get("owner")),
								email: account.get("owner").get("email")
						  },
						  success: function(httpResponse) {
							  var promises = [];
							  promises.push(customer.save());
							  promises.push(account.save());
							  Parse.Promise.when(promises).then(callback, options.error);
						  },
						  error: function(httpResponse) {
								options.error(httpResponse.data);
						  }
						});
				},
				error: options.error
			});
		});
	});
});