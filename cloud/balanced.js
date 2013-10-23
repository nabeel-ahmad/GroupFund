var config = require("cloud/config.js");
var util = require("cloud/util.js");
var _ = require('underscore');

var baseUrl = 'https://'+config.marketPlace.secret+'@api.balancedpayments.com';

exports.addNewAccount = function(user, options) {
	// Create a new "Balanced Account" to handle this credit card
	Parse.Cloud.httpRequest({
		  method: 'POST',
		  url: baseUrl + '/v1/customers',
		  body: {
			name: util.getUserName(user),
			email: user.get("email")
		  },
		  success: function(httpResponse) {
		    options.success(httpResponse.data);
		  },
		  error: function(httpResponse) {
				options.error(httpResponse.data);
		  }
	});
};

exports.associateCard2Account = function (cardUri, accountUri, options) {
    // Associate Credit card to Balanced Account
    Parse.Cloud.httpRequest({
		  method: 'PUT',
		  url: baseUrl + accountUri,
		  body: {
			  card_uri: cardUri
		  },
		  success: function(httpResponse) {
			  	options.success(httpResponse.data);
		  },
		  error: function(httpResponse) {
				options.error(httpResponse.data);
		  }
		});
};

exports.associateBankAccount2Account = function (bankAcctUri, accountUri, merchant, options) {
	// Associate Bank account to Balanced Account
	var body = {
			bank_account_uri: bankAcctUri,
	};
	_.extend(body, merchant);
	
	Parse.Cloud.httpRequest({
		method: 'PUT',
		url: baseUrl + accountUri,
		headers: {
		    'Content-Type': 'application/json'
		  },
		body: body,
		success: function(httpResponse) {
			options.success(httpResponse.data);
		},
		error: function(httpResponse) {
			options.error(httpResponse.data);
		  }
	});
};

exports.chargeBuyerAccount = function(amount, accountUri, merchAcctUri, cause, options) {
	Parse.Cloud.httpRequest({
		method : 'POST',
		url : baseUrl + accountUri + "/debits",
		body : {
			amount : amount,
			on_behalf_of_uri : merchAcctUri,
			appears_on_statement_as : cause
		},
		success : function(httpResponse) {
			options.success(httpResponse.data);
		},
		error : function(httpResponse) {
			console.error("balanced.chargeBuyerAccount failed");
			console.error(httpResponse.data);
			options.error(httpResponse.data);
		  }
	});
};

exports.payout = function(amount, cause, creditsUri, options) {
	Parse.Cloud.httpRequest({
		method : 'POST',
		url : baseUrl + creditsUri,
		body : {
			amount : amount,
			appears_on_statement_as : cause
		},
		success : function(httpResponse) {
			options.success(httpResponse.data);
		},
		error : function(httpResponse) {
			console.error("balanced.payout failed");
			options.error(httpResponse.data);
		  }
	});
};

exports.payoutFee = function(amount, options) {
	Parse.Cloud.httpRequest({
		method : 'GET',
		url : baseUrl + config.marketPlace.uri,
		success : function(httpResponse) {
			var credits_uri = httpResponse.data.owner_account.credits_uri;
			exports.payout(amount, "GroupFund", credits_uri, options);
		},
		error : function(httpResponse) {
			options.error(httpResponse.data);
		  }
	});
};

exports.getCredit = function(credit_uri, options) {
	Parse.Cloud.httpRequest({
		method : 'GET',
		url : baseUrl + credit_uri,		
		success : function(httpResponse) {
			options.success(httpResponse.data);
		},
		error : function(httpResponse) {
			console.error("balanced.getCredit failed");
			options.error(httpResponse.data);
		  }
	});
};

exports.refundPayment = function(refunds_uri, amount, debit_uri, options) {
	Parse.Cloud.httpRequest({
		method : 'POST',
		url : baseUrl + refunds_uri,
		body : {
			amount : amount,
			debit_uri : debit_uri,
		},
		success : function(httpResponse) {
			options.success(httpResponse.data);
		},
		error : function(httpResponse) {
			options.error(httpResponse.data);
		  }
	});
};

exports.deleteBankAccount = function(accountId, options) {
	Parse.Cloud.httpRequest({
		  method: 'DELETE',
		  url: baseUrl + '/v1/bank_accounts/' + accountId,
		  success: function(httpResponse) {
			  options.success(httpResponse.data);
		  },
		  error: function(httpResponse) {
				options.error(httpResponse.data);
		  }
	});
};

exports.invalidateCreditCard = function(cardUri, options) {
	Parse.Cloud.httpRequest({
		method: 'PUT',
		url: baseUrl + cardUri,
		body : {
			is_valid : false
		},
		success: function(httpResponse) {
			options.success(httpResponse.data);
		},
		error: function(httpResponse) {
			options.error(httpResponse.data);
		  }
	});
};

exports.getMarketplaceUri = function() {
	return config.marketPlace.uri;
};
