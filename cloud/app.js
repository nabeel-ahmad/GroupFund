
// These two lines are required to initialize Express in Cloud Code.
var express = require('express');
var moment = require('moment');
var _ = require('underscore');
var balanced = require("cloud/balanced.js");
var payments = require("cloud/payments.js");
var enums = require("cloud/enum.js");
var util = require("cloud/util.js");
var config=require("cloud/config.js");
var app = express();

// Global app configuration section
app.set('views', 'cloud/views');  // Specify the folder to find templates
app.set('view engine', 'ejs');    // Set the template engine
app.use(express.bodyParser());    // Middleware for reading request body

app.get('/activity', function(req, res) {
	Parse.Cloud.useMasterKey();
	var query = new Parse.Query("Activity");
	query.include("owner");
	var id = req.query.id;
	var invitationId = req.query.inv;
	query.get(id, {
		success : function(activity) {
			if(activity.get("type") == enums.type.PERSONAL) {
				res.render('error', {message : "Resource not found"});
			} else {
				var showPayment = activity.get("type") == enums.type.CROWD;
					
				var result = {
					appId:config.appKey.applicationId,
					jsKey:config.appKey.js,
					marketplaceUri : balanced.getMarketplaceUri(),
					mixPannelKey:config.mixPannel.key,
					activity : activity,
					fees : enums.fees,
					truncatedTitle : "$" + activity.get("amount")/100 + " - " + util.truncateTitle(activity.get("title"))
				};			
				if(activity.get("endDate"))
					result.endDateStr = moment(activity.get("endDate")).format('ddd, MMM DD, YYYY');
				if(invitationId) {
					query = activity.relation("invitations").query();
					query.get(invitationId).then(function(invitation) {
						if(!invitation.get("user"))
							showPayment = true;
						result.invitation = invitation;
						result.fee = payments.calculatePayerFee(invitation.get("invitee").amount);
						result.total = invitation.get("invitee").amount + result.fee;
						result.showPayment = showPayment;
						result.truncatedTitle = "$" + invitation.get("invitee").amount/100 + " - " + util.truncateTitle(activity.get("title"));
						res.render('activity', result);
					}, function(error) {
						console.error("Resource not found.");
						res.render('error', error);
					});
				} else if(activity.get("type") == enums.type.GROUP) {
					// invitation id is missing
					res.render('error', {message : "Resource not found."});
				} else {
			
					result.showPayment = showPayment;
					res.render('activity', result);
				}	
			}
		},
		error : function(error) {
			console.error("Resource not found.");
			res.render('error', error);
		}
	});
});

// // Example reading from the request query string of an HTTP get request.
// app.get('/test', function(req, res) {
//   // GET http://example.parseapp.com/test?message=hello
//   res.send(req.query.message);
// });

// // Example reading from the request body of an HTTP post request.
// app.post('/test', function(req, res) {
//   // POST http://example.parseapp.com/test (with request body "message=hello")
//   res.send(req.body.message);
// });

// Attach the Express app to Cloud Code.
app.listen();
