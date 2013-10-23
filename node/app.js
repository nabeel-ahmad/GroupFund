var NodeParseAPI = require('node-parse-api').Parse;
var express = require('express');
var balanced_library = require('balanced-official');
var scheduler=require('node-schedule');
var async=require('async');
var http = require('https');
var config = require('./config');

var parse = new NodeParseAPI(config.appKey.applicationId, config.appKey.master);
var app = express();

app.use(express.basicAuth(config.username, config.password));

var balanced = new balanced_library({
    marketplace_uri: config.marketPlace.uri,
    secret: config.marketPlace.secret
});

app.use(express.bodyParser());

var shortTitle;
var merchAcctUri;
var collectedAmount = 0;
app.post('/collectAndClose', function(req, res) {
	var activity = req.body.activity;
	var transactions = req.body.transactions;
	merchAcctUri = req.body.merchantAccountUri;
	var voucherId = req.body.voucherId;
	
	shortTitle = activity.title;
	if(shortTitle.length > 13)
		shortTitle = shortTitle.substring(0, 9) + "...";
	shortTitle = "GroupFund " + shortTitle;

	scheduler.scheduleJob(new Date(), function(){
		async.each(transactions, processTransaction, function(err){
			// This should execute after all transactions have been processed
			if(err) {
				console.error("		>>>		Error Callback		<<<<	");
				console.error(err);
			} 
			// Pay merchant
			var body = JSON.stringify({
				activityId : activity.objectId,
				voucherId : voucherId,
				userId : activity.owner.objectId
			});
			var auth = 'Basic ' + new Buffer(config.appKey.applicationId + ':' + config.appKey.master).toString('base64');
			var headers = {
					Authorization: auth, 
					"Content-type": "application/json",
					"Content-length": body.length
			};
			var options = {
					host: 'api.parse.com',
					port: 443,
					path: '/1/functions/payMerchant',
					method: 'POST',
					headers: headers,
			};
			var postReq = http.request(options, function(res) {  
				res.setEncoding('utf8');  
				res.on('data', function (chunk) {  
					console.log('Response: ' + chunk);  
				});
				res.on('error',function(e){
					console.log("Error: " + hostNames[i] + "\n" + e.message); 
					console.log( e.stack );
				});
			});
			postReq.write(body, 'utf8');
			postReq.end();
		});
	});
	res.json("processing");
});

function processTransaction(trx, callback) {
	var amountPlusFee = trx.amount + trx.fee;
	
	if(trx.status == "done") {
		callback();
	} else if(trx.status == "pending") {		
		balanced.Customers.get(trx.payerAccountUri, function(err, result) {
			if(err) callback(err);
		    var user = balanced.Customers.balanced(result);
		    user.Debits.create({ 
		    			amount: amountPlusFee,
		    			on_behalf_of_uri : merchAcctUri,
		    			appears_on_statement_as : shortTitle
		    	}, function(err, result) {
		    	if(err) {
		    		trx.status = "failed";
					var failureCause = "Oops! Something went wrong. Don't worry, your data and transactions are always safe. Please try again or contact support team."; 
					if(err.additional) {
						console.error(err.description);
						console.error(err.additional);
					}
					trx.failureCause = failureCause;
					// TODO notify Trx Failure to Organizer
					parse.update('Transaction', trx.objectId, trx, callback);
		    	} else {
				    trx.uri = result.uri;
				    trx.lastFour = result.source.last_four;
				    trx.status = "done";
				    parse.update('Transaction', trx.objectId, trx, callback);
		    	}
		    });
		});
	} else {
		callback();
	}
}

app.get('/', function(req, res) {
	res.json({message:"hello REST"});
});

var port = process.env.PORT || 5000;
app.listen(port, function() {
  console.log("Listening on " + port);
});