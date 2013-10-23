var enums = require("cloud/enum.js");
var balanced = require("cloud/balanced.js");
var moment = require('moment');
var util = require("cloud/util.js");
var config = require("cloud/config.js");
var notifications = require("cloud/notifications.js");
var config = require("cloud/config.js");
var _ = require('underscore');

exports.saveTransaction = function (amount, fee, payer, activity, invitation, voucher, options) {	
	util.startTimer(options,'saveTransaction');
    Parse.Cloud.useMasterKey(); // This is to bypass raisedAmount security check in Activity beforeSave method
    var promises = [];
    var query = new Parse.Query("Transaction");
    query.equalTo("owner", payer);
    query.greaterThan("createdAt", moment().add('hours', -24).toDate());
    query.count().then(function(count) {
		if(count >= config.daily_trx_limit) {
			options.error("Due to security reasons, we only allow one payment every 24 hours.");
			return;
		} else {
			query = new Parse.Query("BalancedCustomer");
			query.equalTo("owner", payer);
			query.select("uri");
			query.first({
				success : function(account) {
					if(account && account.get("uri")) {
						activity.increment("raisedAmount", amount);
						activity.increment("contributionCount");
						var Transaction = Parse.Object.extend("Transaction");
					    var tr = new Transaction();
						tr.set("payerAccountUri", account.get("uri"));
						tr.set("amount", amount);
					    tr.set("fee", fee);
					    tr.set("activity", activity);
					    tr.set("activityId", activity.id);
					    tr.set("owner", payer);
					    tr.set("status", enums.status.PENDING);
					    tr.set("feeCollected", voucher ? true : false);
					    if(invitation)
					    	tr.set("invitation", invitation);
					    if(voucher) {
					    	tr.set("voucher", voucher);
					    	tr.set("promoTitle", voucher.get("promoTitle"));
					    }
						var acl = new Parse.ACL();
						acl.setPublicReadAccess(true);
						tr.setACL(acl);
						
						promises.push(tr.save());
						promises.push(notifications.notifyTrxOrganiser(activity,tr));
						
						if(invitation) {
		    				invitation.set("status", enums.status.INVITATION.PAID);
		    				invitation.set("transaction", tr);
		    				promises.push(invitation.save());
		    			} if(voucher) {
							voucher.set("used", true);
							voucher.set("usedOn", new Date());
							promises.push(voucher.save());
						}
		    			
		    			Parse.Promise.when(promises).then(function() {
		    				options.success(invitation ? invitation : tr);
						}, options.error);
					}
				},
				error : function(error){
					options.error(error);
				}
			});
		}
	}, options.error);
};


exports.fundActivity = function(activityId, voucherId, appVersion, options) {
	util.startTimer(options,'fundActivity');
	Parse.Cloud.useMasterKey();
	
	var transactions = null;
	var settings = null;
	var activity = null;
	var merchAcct = null;
	var voucher = null;
	var promises = [];
	
	var query = new Parse.Query("UserSettings");
	query.equalTo("owner", Parse.User.current());
	query.select("phoneVerified");
    promises.push(query.first({
        success : function(result) {
        	settings = result;
        }
    }));
    
    query = new Parse.Query("Activity");
	query.include("owner");
	query.containedIn("status", [enums.status.WAITING, enums.status.ENDED]);
	query.equalTo("owner", Parse.User.current());
	promises.push(query.get(activityId, {
    	success : function(result) {
    		activity = result;
    	}
    }));
	
	query = new Parse.Query("Transaction");
	query.include("owner");
	query.include("activity");
	query.equalTo("activityId", activityId);
	query.limit(enums.max_payments);
	promises.push(query.collection().fetch({
		success : function(result) {
    		transactions = result;
    	}
	}));
	
	query = new Parse.Query("BalancedCustomer");
	query.equalTo("owner", Parse.User.current());
	query.equalTo("isMerchant", true);
	promises.push(query.first({
		success : function(result) {
			merchAcct = result;
		}
	}));
	
	if(voucherId) {
		var query = new Parse.Query("Voucher");
		query.equalTo("owner", Parse.User.current());
		query.equalTo("used", false);
		query.greaterThan("expiresOn", new Date());
		promises.push(query.get(voucherId, {
			success: function(result) {
				voucher = result;
			}
		}));
	}
	
	Parse.Promise.when(promises).then(function() {
		if(!settings.get("phoneVerified")) {
    		options.error("Phone Number must be verified.");
    	} if(!merchAcct) {
    		options.error("Merchant identity must be verified.");
    	} else {
    		if(activity.get("raisedAmount") < enums.min_amount) {
    			options.error("Raised amount should be greater than " + enums.min_amount + " cents.");
    			return;
    		} else if(transactions.length == 0) {
				activity.set("status", enums.status.CLOSED);
				activity.save(null, options);
			} else {
				if(voucher) {
					activity.set("fee", 0);
				}				
				if(!appVersion) {
					options.error("We have noticed that you are using an older version of GroupFund. For Collection performance reasons, we have uploaded a newer version to AppStore. Please download the latest version from AppStore and run the Collection again. Sorry for the inconvenience.");
				}
				else if(appVersion >= 1.04) {
					activity.set("status", enums.status.PROCESSING);  
					activity.set("payoutTime", new Date());  
					activity.set("endDate", new Date());
					Parse.Cloud.httpRequest({
						  method: 'POST',
						  url: 'https://'+config.nodeServer.username+':'+config.nodeServer.password+'@' + config.nodeServer.baseURL + '/collectAndClose',
						  headers: {
						    'Content-Type': 'application/json'
						  },
						  body: {
							  activity : activity,
							  transactions : transactions,
							  merchantAccountUri : merchAcct.get("uri"),
							  voucherId : voucherId
						  },
						  success: function(httpResponse) {
							activity.save(null, options);
						  },
						  error: function(httpResponse) {
								options.error(httpResponse.data);
						  }
					});
				}
			}
    	}
	}, options.error);
};

exports.cancelTransaction = function(trId, options) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Transaction");
	query.include("activity");
	query.include("invitation");
	query.include("voucher");
	query.include("owner");
	query.equalTo("status", enums.status.PENDING);
	query.get(trId).then(
		function(trx) {
			if(trx.get("activity").get("endDate") < new Date()) {
				options.error("Transaction cannot be cancelled as the activity has ended.");
				return;
			}
			if(trx.get("owner").id == Parse.User.current().id || trx.get("activity").get("owner").id == Parse.User.current().id) {
				
				trx.set("status", enums.status.CANCELED);
				var raisedAmount = trx.get("activity").get("raisedAmount");
				raisedAmount -= trx.get("amount");
				var amount=trx.get("amount");
				trx.get("activity").set("raisedAmount", raisedAmount);
				if(trx.get("invitation"))
					trx.get("invitation").set("status", enums.status.INVITATION.PENDING);
				if(trx.get("voucher")) {
					trx.get("voucher").set("used", false);
					trx.get("voucher").unset("usedOn");
				}
				trx.get("activity").increment("contributionCount",-1);
				trx.save().then(function(trx){
					notifications.notifyCancelTransaction(trx,amount,options);
				},
				function(obj, error){
			    	options.error(error);
			    });
				    
			} else {
				options.error("Unauthorized");
				return;
			}
		}, 
		function(obj,error){
			options.error(error);	
		},
		function(obj,error) {
			options.error(error);
		});
};

exports.cancelActivity = function(activityId, options) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Activity");
	query.include("owner");
	query.include("sender");
	query.containedIn("status", [enums.status.WAITING, enums.status.ENDED]);
	query.equalTo("payoutStatus", enums.payout_status.NOT_STARTED);
	
    query.get(activityId).then(
    	function(activity) {
    		
    		var permission = false;
    		if(activity.get("sender")) {
    			if(activity.get("sender").id == Parse.User.current().id)
    				permission = true;
    		} 
    		else if(activity.get("owner").id == Parse.User.current().id )
    			permission = true;
    		
    		if(!permission) {
    			options.error("Access denied");
    			return;
    		}
    			
    		
    		var query = new Parse.Query("Transaction");
    		query.include("owner");
    		query.include("voucher");
    		query.equalTo("activity", activity);
    		query.equalTo("status", enums.status.PENDING);	
    		
    		var transactions = query.collection();
    		transactions.fetch().then(function(transactions) {
    			if(activity.get("endDate") > new Date()) {
    				activity.set("endDate", new Date());
    			}
    			activity.set("status", enums.status.CLOSED);
    			activity.save().then(
    				function(activity) {
    					if(transactions.length == 0)
    						options.success(activity);
    					
    					var recepients=[];
    					var pushRecepients=[];
    					var promises=[];
    					
    					promises.push(notifications.notifyCancelActivityOrganizer(activity));
    					transactions.each(function(trx) {
							trx.set("status", enums.status.CANCELED);
							if(trx.get("voucher")) {
								trx.get("voucher").set("used", false);
								trx.get("voucher").unset("usedOn");
							}
							trx.save().then(
            						function(trx) {
            							pushRecepients.push(trx.get("owner"));
            							if(activity.get("type") == "personal"){
            								pushRecepients.push(activity.get("owner"));
            								recepients.push({email:trx.get("owner").get("email"), name:util.getUserName(trx.get("owner"))});
            							}
            								
            						},
            						options.error
            					);
    					  });	
    					promises.push(notifications.notifyCancelActivityContributors(activity,pushRecepients,recepients));
    					Parse.Promise.when(promises).then(function(){
    						options.success(activity);
    					});
    				  });
    				},
    				options.error
    			);
    		}, options.error);   	
};

exports.addNewAccount = function(user, options) {
	balanced.addNewAccount(user, {
		success: function(accountObj) {
			var BalancedAccount = Parse.Object.extend("BalancedCustomer");
			var account = new BalancedAccount();
			account.set("uri", accountObj.uri);
			account.set("credits_uri", accountObj.credits_uri);
			account.set("owner", user);
			var acl = new Parse.ACL();
			account.setACL(acl);
			account.save(null, options);
		},
		error: options.error
	});
};

exports.associateCard2Account = function (card, user, accountUri, options) {
	Parse.Cloud.useMasterKey();
	
	var checks = ["is_valid", "is_verified", "postal_code_check", "security_code_check"];
	var errors = ["If you believe your Card is valid, please contact us at +1 (510)-394-5732.",
	              "If you believe your Card is valid, please contact us at +1 (510)-394-5732.",
	              "The Postal Code is invalid",
	              "Invalid Security Code or Expiration Date."
	              ];
	for ( var i = 0; i < checks.length; i++) {
		var check = checks[i];
		if(card[check] != "true" && card[check] != "passed" && card[check] != 1) {
			options.error("Credit Card verification failed. " + errors[i]);
			return;
		}
	}
	
	var callback = function() {
		balanced.associateCard2Account(card.uri, accountUri, {
			success: function(data) {
				if(user.get("anonymous")) {
					options.success();
				} else {
					var query = new Parse.Query("UserSettings");
					query.equalTo("owner", user);
					query.first().then(function(settings) {
						if(settings) {
							settings.set("creditCard", card);
							settings.save().then(function(settings) {
								options.success("Credit Card has been added successfully!");
							});
						}
					});
				}
			},
			error: function(error) {
				if(error)
					options.error(error.description);
				else
					options.error("Balanced payments processing error.");
			}
		});
	};
	
	// Invalidate old credit card if any, before associating the new one
	exports.invalidateCreditCard({
		error : options.error,
		success : callback
	});
};

exports.invalidateCreditCard = function(options) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("UserSettings");
	query.equalTo("owner", Parse.User.current());
	query.first().then(
			function(settings) {
				if(settings && settings.get("creditCard")) {
					balanced.invalidateCreditCard(settings.get("creditCard").uri, {
						success: function(data) {
							// Update user settings
							settings.unset("creditCard");
							settings.save().then(function(settings) {
								options.success("Credit Card has been invalidated.");
							});
						},
						error: function(error) {
							if(error)
								options.error(error.description);
							else
								options.error("Balanced payments processing error.");
						}
					});
				} else {
					options.success("Resource not found.");
				}
			},
			options.error
	);
};

exports.associateBankAccount2Account = function (bankAcct, account, merchant, options) {
	Parse.Cloud.useMasterKey();
	if(!bankAcct || bankAcct._type != "bank_account") {
		options.error("Invalid bank account");
		return;
	}
	
	if(merchant && merchant.phone_number) {
		// For older version
		merchant.phone = merchant.phone_number;
	}
	
	var callback = function() {
		balanced.associateBankAccount2Account(bankAcct.uri, account.get("uri"), merchant, {
			success: function(data) {
				account.set("isMerchant", data.is_identity_verified);
				account.save().then(
					function(account) {
						var query = new Parse.Query("UserSettings");
						query.equalTo("owner", Parse.User.current());
						query.first().then(function(settings) {
							if(settings) {
								settings.set("bankAccount", bankAcct);
								settings.set("merchant", merchant);
								/*if(settings.get("phoneVerified") == false && merchant.phone_number)
									settings.set("phone", merchant.phone_number);*/
								settings.save().then(function(settings) {
									options.success("Bank Account has been added successfully!");
								}, options.error);
							}
						});
					}	
				);
			},
			error: function(error) {
				if(error)
					options.error(error.description);
				else
					options.error("Balanced payments processing error.");
			}
		});
	};
	
	// Delete old bank account if any, before associating the new one
	exports.deleteBankAccount({
		error : options.error,
		success : callback
	});
};

exports.deleteBankAccount = function(options) {
	Parse.Cloud.useMasterKey();
	
	var query = new Parse.Query("UserSettings");
	query.equalTo("owner", Parse.User.current());
	query.first().then(function(settings) {
		if(settings) {
			if(!settings.get("bankAccount")) {
				options.success("Bank Account has been deleted.");
				return;
			}
			balanced.deleteBankAccount(settings.get("bankAccount").id, {
				success : function(data) {
					// Update user settings
					settings.unset("bankAccount");
					settings.save().then(function(settings) {
						query = new Parse.Query("BalancedCustomer");
						query.equalTo("owner", Parse.User.current());
						query.first().then(function(acct) {
							acct.set("isMerchant", false);
							acct.save().then(function() {
								options.success("Bank account deleted");
							}, options.error);
						}, options.error);
					}, options.error);					
				},
				error : options.error
			});
		}
	});
};

// Update Activity payout status for all pending payouts
exports.updatePayoutStatus = function(options) {
	Parse.Cloud.useMasterKey();
	
	var query = new Parse.Query("Activity");
	query.include("owner");
	query.containedIn("payoutStatus", [enums.payout_status.COMPLETE, enums.payout_status.PENDING]);
	query.exists("payoutUri");
	query.greaterThanOrEqualTo("payoutTime",(moment().subtract('days', 7)).toDate());
	query.limit(1); // Parse fairy can only handle one update request at a time more requests give {"code":-1,"message":""} error
	
	var activities = query.collection();
	activities.fetch().then(
			function(activities) {
				
				console.log("Pending payouts: " + activities.length);
				var processed = 0;
				if(activities.length == 0) {
					options.success("Payout status updated for " + processed + " activities");
					return;
				} else {
					activities.each(function(activity) {
						balanced.getCredit(activity.get("payoutUri"), {
							success: function(credit) {
								if(activity.get("payoutStatus") == credit.status) {
									processed++;
									if(processed == activities.length){
										options.success("Payout status updated for " + processed + " activities");		
										return;
									}
								} else {
									
									promises=[];
									activity.set("payoutStatus", credit.status);
									activity.set("payoutTime", new Date(credit.created_at));
									promises.push(activity.save());
									promises.push(notifications.trxInitiatedNotify(activity,credit));
									Parse.Promise.when(promises).then(function(){
										processed++;
										if(processed == activities.length){
												options.success("Payout status updated for " + processed + " activities");	
												return;
										}
									},function(error) {
										processed++;
										console.error("Could not update payout status in DB: " + JSON.stringify(error));
										if(processed == activities.length)
											options.error(error);
									});
								}
							},
							error: function(error) {
								console.error("processed: " + processed + " activities: " + activities.length);
								console.error(error);
								processed++;
								if(processed == activities.length)
									if(error)
										options.error(error.description);
									else
										options.error("Balanced payments processing error.");
							}
						});
					});
				}
			}
	);
};

exports.processExpiredActivities = function(options) {
	
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Activity");
	query.include("owner");
	query.lessThan("endDate", moment().add('hours', 24).toDate());
	query.equalTo("status", enums.status.WAITING);
	query.equalTo("type", enums.type.CROWD);
	var activities = query.collection();
	activities.fetch().then(function(activities) {
		
		console.log("expired: " + activities.length);
		if(activities.length == 0) {
			options.success("Expired activities processed successfully");
			return;
		}

		var promises = [];
		activities.each(function(activity) {
			
		if( activity.get("endDate") < moment().toDate() ){
		    activity.set("status", enums.status.ENDED);
		    var expPromise=notifications.expiredActivitiesNotify(activity);
			promises.push(expPromise);
			promises.push(activity.save());
		} else if( (activity.get("endDate") <= (moment().add('hours', 24)).toDate()) && (activity.get("endDate") >= (moment().add('hours', 23)).toDate()) ){
			
				promises.push(notifications.expiringActivitiesNotify(activity));
			}
		});
		Parse.Promise.when(promises).then(function() {
			options.success("Expired activities processed successfully");								
		}, function(obj, error) {
			options.error(error);
		});
		
	},
	function(error) {
		options.error(error.message);
	});
};

/**
 * 
 * @param activity
 * @param transactions
 * @param options
 */
function collectPayments(activity, transactions, merchAcct, options) {
	
	if(merchAcct) {		
		
		var processed = 0;
		var collectedAmount = 0;
		var promises = [];

		var callback = function() {
			processed++;
			if(processed == transactions.length) {
				if(collectedAmount >= enums.min_amount) {
					activity.set("raisedAmount", collectedAmount);
					activity.set("status", enums.status.ENDED);
					if(activity.get("endDate") > new Date())
						activity.set("endDate", new Date());
					promises.push(activity.save());
					Parse.Promise.when(promises).then(function() {
						options.success(activity);
					}, options.error);
				} else {
					activity.set("payoutStatus", enums.payout_status.PAYMENTS_FAILED);
					activity.set("payoutTime", new Date());
					if(activity.get("endDate") > new Date()) {
						activity.set("endDate", new Date());
					}
					activity.set("status", enums.status.CLOSED);
					promises.push(activity.save());
					Parse.Promise.when(promises).then(function() {
						options.success(activity);
					}, options.error);
				}
			}
		};
		
		var shortTitle = activity.get("title");
		if(shortTitle.length > 13)
			shortTitle = shortTitle.substring(0, 9) + "...";
		shortTitle = "GroupFund " + shortTitle;
		
		
		transactions.each(function(trx){
			var amountPlusFee = trx.get("amount") + trx.get("fee");
			
			if(trx.get("status") == enums.status.DONE) {
				// This is to handle the case where due to some reason server crashed during payments collection before payout
				collectedAmount += trx.get("amount");
				callback();
			} else if(trx.get("status") == enums.status.PENDING) {
				balanced.chargeBuyerAccount(amountPlusFee, trx.get("payerAccountUri"), merchAcct.get("uri"), shortTitle, {
					success : function(tansObj) {
						
						collectedAmount += trx.get("amount");
					    trx.set("uri", tansObj.uri);
					    trx.set("lastFour",tansObj.source.last_four);
					    trx.set("status", enums.status.DONE);
					    promises.push(trx.save());
					    callback();
					},
					error : function(data) {
						trx.set("status", enums.status.FAILED);
						var failureCause = "Oops! Something went wrong. Don't worry, your data and transactions are always safe. Please try again or contact support team."; 
						if(data && data.additional)
							failureCause = data.additional;
						trx.set("failureCause", failureCause);
						activity.increment("contributionCount",-1);
						promises.push(trx.save());
						promises.push(notifications.notifyTrxFailureOrganizer(trx,activity));
						callback();
					}
				});
			} else {
				callback();
			}
			
		});
	} else {
		options.error("Resource not found.");
	}
};



exports.payMerchant = function(activityId, voucherId, currentUser, options) {
	util.startTimer(options,'payMerchant');
	Parse.Cloud.useMasterKey();
	
	var voucher = null;
	var activity = null;
	var account = null;
	var promises = [];
	var transactions = null;
	if(voucherId) {
		var query = new Parse.Query("Voucher");
		query.equalTo("owner", currentUser);
		query.equalTo("used", false);
		query.greaterThan("expiresOn", new Date());
		promises.push(query.get(voucherId, {
			success: function(result) {
				voucher = result;
			}
		}));
	}
	
	var query = new Parse.Query("Activity");
	query.include("owner");
	query.equalTo("owner", currentUser);
	query.containedIn("status", [enums.status.ENDED, enums.status.PROCESSING]);
	query.containedIn("payoutStatus", [enums.payout_status.NOT_STARTED, enums.payout_status.FAILED]);
	promises.push(query.get(activityId, {
		success: function(result) {
			activity = result;
		}
	}));
	
	
	query = new Parse.Query("BalancedCustomer");
	query.equalTo("owner", currentUser);
	query.equalTo("isMerchant", true);
	promises.push(query.first({
		success : function(result) {
			if(result) {		
				account = result;				
			} else {
				options.error("Merchant account does not exist");
			}
		}
	}));
	
	query = new Parse.Query("Transaction");
	query.equalTo("activityId", activityId);
	query.equalTo("status", enums.status.DONE);
	query.limit(enums.max_payments);
	promises.push(query.collection().fetch().then(function(result){
		transactions = result;
	}));
	
	Parse.Promise.when(promises).then(function() {
		if(!account) return;
		
		var collectedAmount = 0;
		transactions.each(function(trx) {
			collectedAmount += trx.get("amount");
		});
		activity.set("raisedAmount", collectedAmount);
		
		if(collectedAmount < enums.min_amount) {
			activity.set("payoutStatus", enums.payout_status.PAYMENTS_FAILED);
			activity.set("payoutTime", new Date());
			activity.set("status", enums.status.CLOSED);
		}
		
		var fee = 0;
		if(!voucher) {
			fee = calculateMerchantFee(collectedAmount);
		}
		if(collectedAmount - fee < enums.min_amount) {
			activity.set("payoutStatus", enums.payout_status.PAYMENTS_FAILED);
			activity.set("payoutTime", new Date());
			if(activity.get("endDate") > new Date()) {
				activity.set("endDate", new Date());
			}
			activity.set("status", enums.status.CLOSED);
			activity.save(null, options);
			return;
		}
		
		var shortTitle = activity.get("title");
		if(shortTitle.length > 13)
			shortTitle = shortTitle.substring(0, 9) + "...";
		shortTitle = "GroupFund " + shortTitle;
		
		balanced.payout(collectedAmount - fee, shortTitle, account.get("credits_uri"), {
			success: function(data) {
				// Activity owner paid successfully
				activity.set("payoutUri", data.uri);
				activity.set("payoutStatus", data.status);
				if(data.status == enums.payout_status.PENDING || data.status == enums.payout_status.COMPLETE) {
					activity.set("status", enums.status.FUNDED);
				}
				activity.set("fee", fee);
				activity.set("feeCollected", voucher ? true : false);
				activity.set("payoutTime", new Date(data.created_at));
				
				if(voucher) {
					voucher.set("used", true);
					voucher.set("usedOn", new Date());
					activity.set("voucher", voucher);
					activity.set("promoTitle", voucher.get("promoTitle"));
				}

				var promises = [];
				promises.push(activity.save());
				transactions.each(function(trx) {
					trx.set("credit_uri", data.uri);
					promises.push(trx.save());
				});
				promises.push(notifications.trxInitiatedNotify(activity,data));		
				Parse.Promise.when(promises).then(function(){
					if(data.status == enums.payout_status.FAILED) {
						// If bank payout fails the bank account should be deleted
						exports.deleteBankAccount({
							success : function() {
								options.success(activity);
							},
							error : options.error
						});
					} else
						options.success(activity);						
				},
				function(error) {
					options.error(error);
				});
					
			},
			error: function(error){
				if(error)
					options.error(error.description);
				else
					options.error("Balanced payments processing error.");
			}
		});
	}, options.error);
};

/**
 * Refund all payments for an activity
 * @param activity
 * @param transactions
 * @param options
 */
function refundPayments(activity, transactions, options) {
	// Refund all payments for this activity as target amount could not be reached
	var successfulrefunds = 0;
	var promises = [];
	var callback = function() {
		successfulrefunds++;
		if(successfulrefunds == transactions.length) {
			activity.set("status", enums.status.CLOSED);
			promises.push(activity.save());
			Parse.Promise.when(promises).then(options.success, options.error);
		}
	};
	transactions.each(function(trx) {
		if(trx.get("refunds_uri")) {
			balanced.refundPayment(trx.get("refunds_uri"), trx.get("amount"), trx.get("debit_uri"), {
				success: function(resp) {
					// Payment refunded successfully
					trx.set("status", enums.status.REFUNDED);
					promises.push(trx.save());
					callback();
				}, 
				error: function(error) {
					if(error)
						options.error(error.description);
					else
						options.error("Balanced payments processing error.");
				}
			});
		} else {
			callback();
		}
	});
};

exports.calculatePayerFee = function(amount) {
	return Math.ceil(amount * (enums.fees.debit_fee_percent/100)) + enums.fees.debit_fee;
};

function calculateMerchantFee(amount) {
	return Math.ceil(amount * (enums.fees.credit_fee_percent/100)) + enums.fees.credit_fee;
};

exports.collectPaymentFees = function(options) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Transaction");
	query.containedIn("status", [enums.status.DONE, enums.status.REFUNDED]);
	query.equalTo("feeCollected", false);	
	
	var transactions = query.collection();
	query.include("owner");
	query.include("activity");
	transactions.fetch().then(function(transactions) {
		if(transactions.length == 0) {
			options.success();
			return;
		}
		var totalFee = 0;
		transactions.each(function(trx) {
			totalFee += trx.get("fee");
		});
		if(totalFee < enums.min_amount) {
			options.success("success");
			return;
		}
		console.log("	totalFee " + totalFee);
		balanced.payoutFee(totalFee, {
			success : function() {
				console.log("	collectedFee " + totalFee);
				var promises = [];
				transactions.each(function(trx) {
					trx.set("feeCollected", true);
					promises.push(trx.save());
					promises.push(notifications.notifyTrxSuccessContributor(trx));
				});
				Parse.Promise.when(promises).then(options.success,options.error);
			},
			error: function(error) {
				if(error)
					options.error(error.description);
				else {
					console.error("collectPaymentFees FAILED");
					options.error("Balanced payments processing error.");
				}
			}
		});
	});
};

exports.collectPayoutFees = function(options) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Activity");
	query.equalTo("status", enums.status.FUNDED);
	query.equalTo("feeCollected", false);	
	
	var activities = query.collection();
	activities.fetch().then(function(activities) {
		var processed = 0;
		if(activities.length == 0) {
			options.success();
			return;
		}
		var totalFee = 0;
		activities.each(function(activity) {
			var fee = activity.get("fee"); 
			totalFee += fee;
		});
		if(totalFee < enums.min_amount) {
			options.success("success");
			return;
		}
		balanced.payoutFee(totalFee, {
			success : function() {
				activities.each(function(activity) {
					activity.set("feeCollected", true);
					activity.save().then(
							function() {
								processed++;
								if(processed == activities.length) {
									options.success("success");
								}
							},
							options.error
					);
				});
			},
			error: function(error) {
				if(error)
					options.error(error.description);
				else {
					console.error("collectPayoutFees FAILED");
					options.error("Balanced payments processing error.");
				}
			}
		});
	});
};