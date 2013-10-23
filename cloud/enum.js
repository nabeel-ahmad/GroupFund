exports.mandrill = {
	username : "developer@snaptrendslab.com",
	password : "4gmnRf1ERKXbcm6dvfjOEw"
};

exports.status = {
	// Activity statuses
	WAITING : "waiting",
	FUNDED : "funded",
	CLOSED : "closed",
	ENDED : "ended",
	PROCESSING : "processing",

	// Transaction statuses
	DONE : "done",
	REFUNDED : "refunded",
	CANCELED : "canceled",
	PENDING : "pending",
	FAILED : "failed",
	
	// Invitation statuses
	INVITATION : {
		PAID : "paid",
		PENDING : "pending",
	}
};

exports.payout_status = {
	NOT_STARTED : "not_started",
	PENDING : "pending",
	COMPLETE : "paid",	
	FAILED : "failed",	
	PAYMENTS_FAILED : "payments_failed" // When all payments for an activity fail 	
};

exports.fees = {
	debit_fee : 30,
	debit_fee_percent : 2.9,
	
	credit_fee : 25,
	credit_fee_percent : 2
};

exports.type = {
	CROWD : "crowd",
	GROUP : "group",
	PERSONAL : "personal"
};

exports.min_amount = 50; // Minimum payable amount
exports.min_trx = 76; // Minimum contribution amount
exports.max_trx = 29900; // Maximum contribution amount
exports.max_goal = 1000000; // Maximum activity amount
exports.max_payments = 250; // Maximum payment count allowed for an activity

exports.twilio_sender = "+16503197565";


exports.page_size = 5;

exports.baseURL = "https://groupfund.parseapp.com";