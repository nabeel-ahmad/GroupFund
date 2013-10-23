var _ = require('underscore');
var enums = require("cloud/enum.js");
var moment = require('moment');

exports.truncateTitle=function(title){
	var arr = title.split(" ");
	if(arr.length <= 2)
		return title;
	else
		return arr[0] + " " + arr[1] + "...";	
};

exports.getUserName=function(owner){
	var name = "";
	if(owner.get("fname"))
		name = owner.get("fname");
	if(owner.get("lname"))
		name = name +" "+owner.get("lname");
	return name;
};
exports.validateRow = function(request, reqFields, readOnlyFields, unchangeableFields) {

	var validation = new Object();

	// fields which cannot be null and have no defaults
	if (reqFields) {
		for ( var i in reqFields) {
			if (request.object.get(reqFields[i]) == null) {
				validation.message = "invalid " + reqFields[i];
				validation.valid = false;
				return validation;
			}
		}
	}
	
	if(readOnlyFields) {
		var hasError = false;
		_.each(readOnlyFields, function(f) {
			if(!request.master && request.object.dirty(f)) {
				validation.message = f + " is a read only field";
				validation.valid = false;
				hasError = true;
			}
		});
		if(hasError)
			return validation;
	}

	// These fields cannot be modified by the user after creation
	if(unchangeableFields && !request.object.isNew()) {
		var hasError = false;
		_.each(unchangeableFields, function(f) {
			if(!request.master && request.object.dirty(f)) {
				validation.message = f + " cannot be changed";
				validation.valid = false;
				hasError = true;
			}
		});
		if(hasError) 
			return validation;
	}

	validation.valid = true;
	return validation;
};

exports.guid = function () {
    function _p8(s) {
        var p = (Math.random().toString(16)+"000000000").substr(2,8);
        return s ? "-" + p.substr(0,4) + "-" + p.substr(4,4) : p ;
    }
    return _p8() + _p8(true) + _p8(true) + _p8();
};

exports.substituteValues = function(string, sender, activity, amount){
	string = string.replace("{senderName}", sender.get("fname"));
	string = string.replace("{activityTitle}", activity.get("title"));
	string = string.replace("{amount}", amount/100);
	return string;
};

exports.getActivityPhotoURL = function(activity){
	if(activity.get("picture"))
		return activity.get("picture")._url;
	else if(activity.get("image"))
		return enums.baseURL + "/images/stock/"+ activity.get("image");
	else
		return enums.baseURL+"/images/logo.png";
};

exports.getUserPhotoURL = function(user){
	if(user.get("picture"))
		return user.get("picture")._url;
	else
		return enums.baseURL + "/images/user_default.png";
};

exports.startTimer = function(options,name){
	var sTime=moment();
	var temp=options.success;
	options.success=function(result){
		var eTime=moment().diff(sTime);
		eTime=eTime/1000;
		if(eTime >= 2)
			console.log("	>>>>>>		Funtion "+name+" took "+eTime+" seconds		<<<<<<	");
		
		temp(result);
	};	
};