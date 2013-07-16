var ReadPreference = require('./connection/read_preference').ReadPreference
	, Readable = require('stream').Readable
	, inherits = require('util').inherits;

var AggregationCursor = function(collection) {	
	var pipe = [];
	var self = this;
	var results = null;	
	
	// Set up
	Readable.call(this, {objectMode: true});

	// Set the read preference
	var _options = { 
		readPreference: ReadPreference.PRIMARY 
	};

	// Internal cursor methods
	this.find = function(selector) {
		pipe.push({$match: selector});
		return self;
	}

	this.unwind = function(unwind) {
		pipe.push({$unwind: unwind});
		return self;
	}

	this.group = function(group) {
		pipe.push({$group: group});
		return self;
	}

	this.project = function(project) {
		pipe.push({$project: project});
		return self;
	}

	this.limit = function(limit) {
		pipe.push({$limit: limit});
		return self;
	}

	this.geoNear = function(geoNear) {
		pipe.push({$geoNear: geoNear});
		return self;
	}

	this.sort = function(sort) {
		pipe.push({$sort: sort});
		return self;
	}

	this.withReadPreference = function(read_preference) {
		_options.readPreference = read_preference;
		return self;
	}

	this.skip = function(skip) {
		pipe.push({$skip: skip});
		return self;
	}

	this.explain = function(callback) {
		// Add explain options
		_options.explain = true;
		// Execute aggregation pipeline
		collection.aggregate(pipe, _options, function(err, results) {
			if(err) return callback(err, null);
			callback(null, results);
		});
	}

	this.get = function(callback) {
		// For now we have no cursor command so let's just wrap existing results
		collection.aggregate(pipe, _options, function(err, results) {
			if(err) return callback(err);
			callback(null, results);
		});
	}

	this.getOne = function(callback) {
		// Set the limit to 1
		pipe.push({$limit: 1});
		// For now we have no cursor command so let's just wrap existing results
		collection.aggregate(pipe, _options, function(err, results) {
			if(err) return callback(err);
			callback(null, results[0]);
		});
	}

	this.each = function(callback) {
		// For now we have no cursor command so let's just wrap existing results
		collection.aggregate(pipe, _options, function(err, _results) {
			if(err) return callback(err);

			while(_results.length > 0) {
				callback(null, _results.shift());
			}

			callback(null, null);
		});	
	}

	this.next = function(callback) {
		if(!results) {
			// For now we have no cursor command so let's just wrap existing results
			return collection.aggregate(pipe, _options, function(err, _results) {
				if(err) return callback(err);
				results = _results;
        
        // Ensure we don't issue undefined
        var item = results.shift();
        callback(null, item ? item : null);
			});			
		}

    // Ensure we don't issue undefined
    var item = results.shift();
    callback(null, item ? item : null);
	}

	//
	// Stream method
	//
	this._read = function(n) {
		if(!results) {
			return self.get(function(err, _results) {
				if(err) {
					self.emit('error', err);
					self.push(null);
				}

				// Return the results
				results = _results;
				// Push the result
				if(results.length > 0) {
					return self.push(results.shift());
				}
		
				// No items			
				return self.push(null);
			});			
		}

		if(results.length > 0) {
			return self.push(results.shift());
		}

		// No items			
		return self.push(null);
	}
}

// Inherit from Readable
inherits(AggregationCursor, Readable);

// Exports the Aggregation Framework
exports.AggregationCursor = AggregationCursor;