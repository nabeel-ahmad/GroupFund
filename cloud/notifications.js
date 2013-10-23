var util = require("cloud/util.js");
var Twilio = require('twilio');
var enums = require("cloud/enum.js");
var _ = require('underscore');

/**
 * 
 */

exports.notifyInvitations=function(activity,activityOwner,options){
	var title=activity.get("title");
	var rel = activity.relation("invitations");
	query = rel.query();
	query.include("user");
	query.collection().fetch().then(function(invitations) {
		if(invitations.length == 0)
			options.success();
		else{
			invitations.each(function(invitation){
				recepients=[];
				emailInfo=[];
				user=invitation.get("user");
				invitee = invitation.get("invitee");
				var recepientEmail;
				var recepientName;
				if(user) {
					recepientName=util.getUserName(user);
					recepientEmail=user.get("email");
				}
				else {
					recepientName=invitee.fname + " " + invitee.lname;
					recepientEmail=invitee.email;
				}
				var url = enums.baseURL + "/activity?id="+activity.id+"&inv="+invitation.id;
				if(recepientEmail) {
					var subject=util.getUserName(activityOwner)+" assigned you a payment of $"+invitee.amount/100+" for '"+util.truncateTitle(title)+"'";
					emailInfo.push({name:"activityTitle", content:title});
					emailInfo.push({name:"organizerFullName", content:util.getUserName(activityOwner)});
					emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(activityOwner)});
					emailInfo.push({name:"userPaymentAmount", content:invitee.amount/100});
					emailInfo.push({name:"subject", content:subject});
					emailInfo.push({name:"activityWebURL", content: url});
					emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
					
					recepients.push({email:recepientEmail, name:recepientName});
					var Notification = Parse.Object.extend("Notification");
					var notify = new Notification();
					notify.set("subject",subject);
					notify.set("activityId",activity.id);
					notify.set("emailRecepients",recepients);
					if(user)
						notify.set("pushRecepients",[user]);
					notify.set("emailInfo",emailInfo);
					notify.set("templateName","n17");
					notify.save().then(function(){
						options.success();
					},
					function(error){
						options.error(error);
					});
				} else if(invitee.phoneNumber) {
					Twilio.sendSMS({
		    			  From: enums.twilio_sender,
		    			  To: invitee.phoneNumber,
		    			  Body: util.getUserName(activityOwner)+" assigned you a payment of $"+invitee.amount/100+" for '"+util.truncateTitle(title)+"' \n" + url
		    			}, {
		    			  success: function(httpResponse) {
		    			    console.log(httpResponse.data);
		    			    options.success();
		    			  },
		    			  error: function(httpResponse) {
		    			    console.error(httpResponse.data);
		    			    options.error("Could not send SMS. Reason: " + httpResponse.data.message);
		    			  }
		    			});
				}
			},
			function(error){
				options.error();
			});
		}

	});
};

exports.notifyTrxFailureOrganizer=function(trx,activity){
	
	////////////Email when a contributors card is not charged -- TO ORGANISER//////////
	var emailInfo=[];
    var recepients=[];
    var amount = trx.get("amount")/100;
    var promises=[];
    
	var owner=activity.get("owner");


	recepientName=util.getUserName(owner);
	payerFullName=util.getUserName(trx.get("owner"));
	recepientEmail=owner.get("email");
	recepients.push({email:recepientEmail, name:recepientName});
	var title=activity.get("title");
	var subject="Payment processing failure for "+payerFullName +" for '"+util.truncateTitle(title)+"'";
	
	emailInfo.push({name:"activityTitle", content:title});
	emailInfo.push({name:"activityAmount", content:(activity.get("amount")/100)});
    emailInfo.push({name:"subject", content:subject});
    emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+activity.id});
    emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
    emailInfo.push({name:"payerFullName", content:util.getUserName(trx.get("owner"))});
    emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(trx.get("owner"))});
    emailInfo.push({name:"payerAmount", content:amount});
    
    var Notification = Parse.Object.extend("Notification");
    var notify = new Notification();
    
    notify.set("emailRecepients",recepients);
    notify.set("emailInfo",emailInfo);
    notify.set("subject",subject);
    notify.set("templateName","n3");
    notify.set("activityId",activity.id);
    promises.push(notify.save());
    promises.push(notifyTrxFailureContributor(trx));
    
    return Parse.Promise.when(promises);
	//////////////////////////////////////////////////////////////////////////////////
};

notifyTrxFailureContributor=function (trx){
////////////Email when a contributors card is not charged -- TO CONTRIBUTOR//////////
	
		var emailInfo=[];
		var recepients=[];
		var trowner=trx.get("owner");
		var recepientEmail=trowner.get("email");
		var amountPlusFee = trx.get("amount") + trx.get("fee");
		var cause=trx.get("failureCause");
		var recepientName=util.getUserName(trowner);

		recepients.push({email:recepientEmail, name:recepientName});

		var activity=trx.get("activity");
		activity.fetch("owner").then(function(owner){

		var title=activity.get("title");
		var subject="Payment processing failure for "+recepientName +" for '"+util.truncateTitle(title)+"'";

		emailInfo.push({name:"failureCause", content:cause});	
		emailInfo.push({name:"activityTitle", content:title});
		emailInfo.push({name:"payerAmount", content:(amountPlusFee/100)});
		emailInfo.push({name:"activityAmount", content:activity.get("amount")/100});
		emailInfo.push({name:"subject", content:subject});
	    emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+activity.id});
	    emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
	    emailInfo.push({name:"payerFullName", content:recepientName});
	    emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(trowner)});
	    emailInfo.push({name:"last4DigitsOfCC", content:trx.get("lastFour")});
	    
		var Notification = Parse.Object.extend("Notification");
		var notify = new Notification();

		notify.set("emailRecepients",recepients);
		notify.set("emailInfo",emailInfo);
		notify.set("subject",subject);
		notify.set("templateName","n2");
		notify.set("activityId",activity.id);
		return notify.save();
		
	});
		
};					

exports.notifyTrxSuccessContributor=function(trx){

	var amountPlusFee = trx.get("amount") + trx.get("fee");
    var emailInfo=[];
    var owner=trx.get("owner");
    var recepientEmail=owner.get("email");
    var recepientName=util.getUserName(owner);
    var pushRecepients=[];
    var recepients={email:recepientEmail, name:recepientName};
    var title=trx.get("activity").get("title");
    
    if(owner.id != trx.get("activity").get("owner").id)
    	pushRecepients.push(owner);
    var subject="Your credit card ending with "+trx.get("lastFour")+" has been charged $"+(amountPlusFee/100)+" for '"+ util.truncateTitle(title) +"' ";
	emailInfo.push({name:"activityTitle", content:title});
	emailInfo.push({name:"payerAmount", content:(amountPlusFee/100)});
    emailInfo.push({name:"subject", content:subject});
    emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+trx.get("activity").id});
    emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(trx.get("activity"))});
    emailInfo.push({name:"activityAmount", content:trx.get("activity").get("amount")/100});
    emailInfo.push({name:"payerFullName", content:recepientName});
    emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(owner)});
    emailInfo.push({name:"last4DigitsOfCC", content:trx.get("lastFour")});
    
    var Notification = Parse.Object.extend("Notification");
    var notify = new Notification();
    
    notify.set("emailRecepients",[recepients]);
    notify.set("pushRecepients",pushRecepients);
    notify.set("emailInfo",emailInfo);
    notify.set("subject",subject);
    notify.set("templateName","n1");
    notify.set("activityId",trx.get("activity").id);
    return notify.save();

};

exports.expiredActivitiesNotify=function (activity){

	emailInfo=[];
	recepients=[];				
	var owner=activity.get("owner");
	var title=activity.get("title");
	var recepientEmail=owner.get("email");
	var recepientName=util.getUserName(owner);
	var subject="'"+util.truncateTitle(title)+"' has ended";

	recepients.push({email:recepientEmail, name:recepientName});
	emailInfo.push({name:"activityTitle", content:title});
	emailInfo.push({name:"activityAmount", content:activity.get("amount")/100});
	emailInfo.push({name:"activityCommittedTotal", content:activity.get("raisedAmount")/100});
	emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+activity.id});
	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
	emailInfo.push({name:"subject", content:subject});
	emailInfo.push({name:"organizerFullName", content:recepientName});
	emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(owner)});

	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();

	notify.set("emailRecepients",recepients);
	notify.set("emailInfo",emailInfo);
	notify.set("subject",subject);
	notify.set("pushRecepients",[owner]);
	notify.set("templateName","n13");
	notify.set("activityId",activity.id);
	return notify.save();

};

exports.notifyCancelTransaction=function(trx,amount,options){
	////////////Email when a contributor cancels transaction/////////////
    //this email is sent to both contributor and actiivity owner covering point 6 7 of document////
    var emailInfo=[];
    var recepients=[];
    var contributingRecepients=[];
    var promises=[];
    
    var owner=trx.get("owner");
    var recepientEmail=owner.get("email");
    var recepientName=util.getUserName(owner);
    emailInfo.push({name:"payerFullName", content:recepientName});
    emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(owner)});
    contributingRecepients.push({email:recepientEmail, name:recepientName});
    
    var activity=trx.get("activity");
    var title=activity.get("title");
    var subject=recepientName+" cancelled the payment of $"+ (amount/100) +" for '"+util.truncateTitle(title)+"'";
    owner=activity.get("owner");
    owner.fetch("owner").then(function(owner){
    	
    	recepientName=util.getUserName(owner);
    	recepientEmail=owner.get("email");
    	recepients.push({email:recepientEmail,name:recepientName});
    	    	
    	
		emailInfo.push({name:"activityTitle", content:title});
		emailInfo.push({name:"amount", content:(amount/100)});
		emailInfo.push({name:"activityAmount", content:activity.get("amount")/100});
	    emailInfo.push({name:"subject", content:subject});
	    emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+activity.id});
	    emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
	    emailInfo.push({name:"payerAmount", content: (amount/100)});
	   
	    
	    var Notification = Parse.Object.extend("Notification");
	    var n7 = new Notification();
	    
	    var n6 = new Notification();
	    n6.set("emailRecepients",contributingRecepients);
	    n6.set("emailInfo",emailInfo);
	    n6.set("subject",subject);
	    n6.set("templateName","n6");
	    n6.set("activityId",activity.id);
	    promises.push(n6.save());
	    
	    n7.set("emailRecepients",recepients);
	    if(owner.id != trx.get("owner").id)
	    	n7.set("pushRecepients",[owner]);
	    n7.set("emailInfo",emailInfo);
	    n7.set("subject",subject);
	    n7.set("templateName","n7");
	    n7.set("activityId",activity.id);
	    promises.push(n7.save());
	    
	    Parse.Promise.when(promises).then(function(){
	    	options.success(trx);
	    },
	    function(obj,error){
	    	options.error(error);
	    });
    },
    function(obj, error){
    	options.error(error);
    });

};
exports.trxInitiatedNotify=function(activity,data){
	
	var emailInfo=[];
	var recepients=[];
	
	var amount=activity.get("raisedAmount")-activity.get("fee");
	var title=activity.get("title");
	var owner=activity.get("owner");
    var recepientEmail=owner.get("email");
    var recepientName=util.getUserName(owner);
    recepients.push({email:recepientEmail, name:recepientName});

	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();

    if(data.status == enums.payout_status.PENDING){
    	var subject="Payout of $"+ (amount/100)+" has been initiated ";
	
    	var str=new String();
    	str=data.bank_account.account_number;
    	account_no=str.substring(str.length-4);
    	emailInfo.push({name:"activityTitle", content:title});
    	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
    	emailInfo.push({name:"payOutAmount", content:(activity.get("raisedAmount")-activity.get("fee"))/100});
    	emailInfo.push({name:"subject", content:subject});
    	emailInfo.push({name:"last4DigitsOfBankAccount", content:account_no});
    	
    	notify.set("emailRecepients",recepients);
    	notify.set("emailInfo",emailInfo);
    	notify.set("subject",subject);
    	notify.set("templateName","n8");
    	notify.set("activityId",activity.id);
    }else if(data.status == enums.payout_status.FAILED){
 
       	var subject="Your payout of $"+(amount/100)+" failed. Please contact us at +1(510)-394-5732 to reprocess the payout";
    	
       	var str=new String();
    	str=data.bank_account.account_number;
    	account_no=str.substring(str.length-4);
    	
    	emailInfo.push({name:"activityTitle", content:title});
    	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
    	emailInfo.push({name:"payOutAmount", content:(activity.get("raisedAmount")-activity.get("fee"))/100});
    	emailInfo.push({name:"subject", content:subject});
    	emailInfo.push({name:"last4DigitsOfBankAccount", content:account_no});
    	emailInfo.push({name:"phoneNumber", content:"+1(510)-394-5732"});
    
    	notify.set("emailRecepients",recepients);
    	notify.set("pushRecepients",[owner]);
    	notify.set("emailInfo",emailInfo);
    	notify.set("subject",subject);
    	notify.set("templateName","n10");
    	notify.set("activityId",activity.id);
    }else if(data.status == enums.payout_status.COMPLETE){
    	var str=new String();
    	str=data.bank_account.account_number;
    	account_no=str.substring(str.length-4);
       	var subject="Your payout of $"+(amount/100)+" deposited successfully to the Bank Account ending with "+account_no;
    	
    	emailInfo.push({name:"activityTitle", content:title});
    	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
    	emailInfo.push({name:"payOutAmount", content:(activity.get("raisedAmount")-activity.get("fee"))/100});
    	emailInfo.push({name:"subject", content:subject});
    	emailInfo.push({name:"last4DigitsOfBankAccount", content:account_no});
    
    	notify.set("emailRecepients",recepients);
    	notify.set("pushRecepients",[owner]);
    	notify.set("emailInfo",emailInfo);
    	notify.set("subject",subject);
    	notify.set("templateName","n9");
    	notify.set("activityId",activity.id);
    }
    return notify.save();

};

exports.notifyTrxOrganiser=function(activity,transaction){	
	var promises=[];
	var pushRecepeints = [];
	if(transaction.get("owner").id != activity.get("owner").id)
		pushRecepeints.push(activity.get("owner"));

	var recepientEmail=activity.get("owner").get("email");
	var recepientName=util.getUserName(activity.get("owner"));
	var title=activity.get("title"); 
	var amount=transaction.get("amount");
	amount=amount/100;
	var contributor=transaction.get("owner");

	var emailInfo=[];
	var recepients = [];
	var contributingRecepients=[];
	var contributorName=util.getUserName(contributor);
	var url = enums.baseURL + "/activity?id="+activity.id;
	var contributorEmail=contributor.get("email");
	contributingRecepients.push({email:contributorEmail, name:contributorName});
	var Notification = Parse.Object.extend("Notification");

	var n5 = new Notification();
	var n4= new Notification();

	var subjectN4="You sent a payment of $"+amount+" for '"+util.truncateTitle(title) +"'";
	var subject=contributorName+" sent a payment of $"+amount+" for '"+util.truncateTitle(title) +"'";
	emailInfo.push({name:"activityTitle", content:title});
	emailInfo.push({name:"payerFullName", content:contributorName});
	emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(contributor)});
	emailInfo.push({name:"payerAmount", content:amount});
	emailInfo.push({name:"activityAmount", content:activity.get("amount")/100});
	emailInfo.push({name:"activityWebURL", content:url});
	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});

	recepients.push({email:recepientEmail, name:recepientName});

	n4.set("subject",subjectN4);
	n4.set("emailRecepients",contributingRecepients);
	n4.set("emailInfo",emailInfo);
	n4.set("templateName","n4");
	n4.set("activityId",activity.id);
	promises.push(n4.save()); 

	if(activity.get("type") != enums.type.PERSONAL){

		n5.set("subject",subject);
		n5.set("emailRecepients",recepients);
		n5.set("pushRecepients",pushRecepeints);
		n5.set("emailInfo",emailInfo);
		n5.set("templateName","n5");
		n5.set("activityId",activity.id);
		promises.push(n5.save());
	}

	return Parse.Promise.when(promises);
};

exports.notifyPendingPayments=function(invitations,activity,options){
	
	var processed=0;
	var callback=function(){
		processed++;
		if(processed == invitations.length){
			options.success();
		}
	};
	invitations.each(function(invitation){
		recepients=[];
		emailInfo=[];
		user=invitation.get("user");
		invitee = invitation.get("invitee");
		var recepientEmail;
		var recepientName;
		if(user) {
			recepientName=util.getUserName(user);
			recepientEmail=user.get("email");
		}
		else {
			recepientName=invitee.fname + " " + invitee.lname;
			recepientEmail=invitee.email;
		}
		var url = enums.baseURL + "/activity?id="+activity.id+"&inv="+invitation.id;
		if(recepientEmail) {
			var subject=util.getUserName(activity.get("owner"))+" sent you a reminder for payment of $"+invitee.amount/100+" for '"+util.truncateTitle(activity.get("title"))+"'";
			emailInfo.push({name:"activityTitle", content:activity.get("title")});
			emailInfo.push({name:"organizerFullName", content:util.getUserName(activity.get("owner"))});
			emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(activity.get("owner"))});
			emailInfo.push({name:"userPaymentAmount", content:invitee.amount/100});
			emailInfo.push({name:"subject", content:subject});
			emailInfo.push({name:"activityWebURL", content: url});
			emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
			
			recepients.push({email:recepientEmail, name:recepientName});
			var Notification = Parse.Object.extend("Notification");
			var notify = new Notification();
			notify.set("subject",subject);
			notify.set("activityId",activity.id);
			notify.set("emailRecepients",recepients);
			
			if(user)
				notify.set("pushRecepients",[user]);
			notify.set("emailInfo",emailInfo);
			notify.set("templateName","n15");
			notify.save().then(function(){
				callback();
			},
			function(obj, error){
				options.error(error);
			});
		} else if(invitee.phoneNumber) {
			sms=util.getUserName(activity.get("owner"))+" assigned you the payment of $"+invitee.amount/100+" for '"+util.truncateTitle(activity.get("title"))+"'";
			Twilio.sendSMS({
    			  From: enums.twilio_sender,
    			  To: invitee.phoneNumber,
    			  Body: sms
    			}, {
    			  success: function(httpResponse) {
    			    console.log(httpResponse.data);
    			    callback();
    			  },
    			  error: function(httpResponse) {
    			    console.error(httpResponse.data);
    			    options.error("Could not send SMS. Reason: " + httpResponse.data.message);
    			  }
    			});
		}
	});

};

exports.notifyPaymentRecieved=function(activity){
	

		var emailInfo=[];
		var recepients=[];
		
		if(activity.get("recepient").email){
			var url = enums.baseURL + "/activity?id="+activity.id;
			var recepientName=util.getUserName(activity.get("owner"));
			var recepientEmail=activity.get("owner").get("email");
			recepients.push({email:recepientEmail,name:recepientName});
			
			var senderName=util.getUserName(activity.get("sender"));
			var subject=senderName+" sent you a payment of $"+(activity.get("amount")/100)+" for "+util.truncateTitle(activity.get("title"));

			emailInfo.push({name:"activityTitle", content:activity.get("title")});
			emailInfo.push({name:"payerFullName", content:senderName});
			emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(activity.get("sender"))});
			emailInfo.push({name:"payerAmount", content:(activity.get("amount")/100)});
			emailInfo.push({name:"subject", content:subject});
			emailInfo.push({name:"activityWebURL", content: url});
			emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});

			var Notification = Parse.Object.extend("Notification");
			var notify = new Notification();
			
			notify.set("subject",subject);
			notify.set("pushRecepients",[activity.get("owner")]);
			notify.set("emailRecepients",recepients);
			notify.set("emailInfo",emailInfo);
			notify.set("templateName","n16");
			notify.set("activityId",activity.id);
			return notify.save();
			
			
		}
	
};

exports.reminderEmail=function(activity){
	emailInfo=[];
	recepients=[];
	
	if(activity.get("recepient").email){
		var url = enums.baseURL + "/activity?id="+activity.id;
		var recepientName=util.getUserName(activity.get("owner"));
		var recepientEmail=activity.get("owner").get("email");
		recepients.push({email:recepientEmail,name:recepientName});
		
		var senderName=util.getUserName(activity.get("sender"));
		var subject=senderName+" sent you a reminder to collect the payment of $"+(activity.get("amount")/100)+" for "+util.truncateTitle(activity.get("title"));
		
		emailInfo.push({name:"activityTitle", content:activity.get("title")});
		emailInfo.push({name:"payerFullName", content:senderName});
		emailInfo.push({name:"payerPhotoURL", content:util.getUserPhotoURL(activity.get("sender"))});
		emailInfo.push({name:"payerAmount", content:(activity.get("amount")/100)});
		emailInfo.push({name:"subject", content:subject});
		emailInfo.push({name:"activityWebURL", content: url});
		emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
		
		var Notification = Parse.Object.extend("Notification");
		var notify = new Notification();
		
		notify.set("subject",subject);
		notify.set("pushRecepients",[activity.get("owner")]);
		notify.set("emailRecepients",recepients);
		notify.set("emailInfo",emailInfo);
		notify.set("templateName","n18");
		notify.set("activityId",activity.id);
		return notify.save();
	}
	
};

exports.notifyCancelActivityOrganizer=function(activity){
	
	var recepients=[];
	var emailInfo=[];
	var pushRecepients=[];
	var recepientName;
	var recepientEmail;
	if(activity.get("type") == "personal"){
		recepientName=util.getUserName(activity.get("sender"));
		recepientEmail=activity.get("owner").get("email");
		recepients.push({email:recepientEmail, name:recepientName});
		pushRecepients.push(activity.get("owner"));
	}else{
		recepientName=util.getUserName(activity.get("owner")) ;
		recepientEmail=activity.get("owner").get("email");
		recepients.push({email:recepientEmail, name:recepientName});
	}
	
	var subject=recepientName +" cancelled the '"+util.truncateTitle(activity.get("title")) +"'. All payments will be voided ";
	emailInfo.push({name:"activityTitle", content:activity.get("title")});
	emailInfo.push({name:"organizerFullName", content:recepientName});
	emailInfo.push({name:"activityAmount", content:activity.get("amount")});
	emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+activity.id});
	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
	emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(activity.get("owner"))});
	
	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();

		
	
	notify.set("subject",subject);
	notify.set("emailRecepients",recepients);
	notify.set("pushRecepients",pushRecepients);
	notify.set("emailInfo",emailInfo);
	notify.set("templateName","n12");
	notify.set("activityId",activity.id);
	return notify.save();
	
};

exports.notifyCancelActivityContributors=function(activity,pushRecepients,recepients){
	
	var subject=util.getUserName(activity.get("owner")) +" cancelled the '"+util.truncateTitle(activity.get("title")) +"'. All payments will be voided ";
	
	var emailInfo=[];
	emailInfo.push({name:"activityTitle", content:activity.get("title")});
	emailInfo.push({name:"organizerFullName", content:util.getUserName(activity.get("owner"))});
	emailInfo.push({name:"activityAmount", content:activity.get("amount")});
	emailInfo.push({name:"activityWebURL", content:enums.baseURL + "/activity?id="+activity.id});
	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
	emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(activity.get("owner"))});

	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();
	
	notify.set("subject",subject);
	notify.set("emailRecepients",recepients);
	notify.set("emailInfo",emailInfo);
	notify.set("pushRecepients",pushRecepients);
	notify.set("templateName","n11");
	notify.set("activityId",activity.id);
	return notify.save();
	
};

exports.expiringActivitiesNotify=function(activity){
	
	var owner=activity.get("owner");
	var title=util.truncateTitle(activity.get("title"));
	var recepientEmail=owner.get("email");
	var recepientName=util.getUserName(owner);

	var subject="'"+title+"' is ending in 24 hours!";

	var recepients = [{email:recepientEmail, name:recepientName}];
	var emailInfo = [];

	emailInfo.push({name:"activityTitle", content:activity.get("title")});
	emailInfo.push({name:"organizerFullName", content:util.getUserName(activity.get("owner"))});
	emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(activity.get("owner"))});
	emailInfo.push({name:"activityWebURL", content: enums.baseURL + "/activity?id="+activity.id});
	emailInfo.push({name:"activityPhotoURL", content: util.getActivityPhotoURL(activity)});
	emailInfo.push({name:"activityAmount", content: activity.get("amount")/100});
	emailInfo.push({name:"activityCommittedTotal", content: activity.get("raisedAmount")/100});

	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();

	notify.set("emailRecepients",recepients);
	notify.set("emailInfo",emailInfo);
	notify.set("subject",subject);
	notify.set("pushRecepients",[owner]);
	notify.set("templateName","n14");
	notify.set("activityID",activity.id);
	return notify.save();
	
};

exports.inviteToApp = function(emails, sender) {
	var recepients = [];
	var subject = util.getUserName(sender) + " invited you to join GroupFund";
	_.each(emails, function(email) {
		recepients.push({email:email});
	});
	var emailInfo = [];

	emailInfo.push({name:"organizerFullName", content:util.getUserName(sender)});
	emailInfo.push({name:"organizerPhotoURL", content:util.getUserPhotoURL(sender)});

	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();

	notify.set("emailRecepients",recepients);
	notify.set("emailInfo",emailInfo);
	notify.set("subject",subject);
	notify.set("templateName","n19");
	return notify.save();
};

exports.notifyVocucherGranted = function(voucher, friend) {
	var recepientEmail = voucher.get("owner").get("email");
	var recepientName = util.getUserName(voucher.get("owner"));
	var recepients = [{email:recepientEmail, name:recepientName}];
	var subject = "Congratulations! GroupFund Promo Code received";
	var emailInfo = [];

	emailInfo.push({name:"friendFullName", content:util.getUserName(friend)});

	var Notification = Parse.Object.extend("Notification");
	var notify = new Notification();

	notify.set("emailRecepients",recepients);
	notify.set("emailInfo",emailInfo);
	notify.set("pushRecepients",[voucher.get("owner")]);
	notify.set("subject",subject);
	notify.set("templateName","n20");
	notify.set("pushData",{voucher : true});
	return notify.save();
};