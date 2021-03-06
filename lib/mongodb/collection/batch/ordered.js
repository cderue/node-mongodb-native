var shared = require('../shared');

// Insert types
var NONE = 0;
var INSERT = 1;
var UPDATE = 2;
var REMOVE = 3

/**
 * Wraps the operations done for the batch
 */
var OrderedBulkOperation = function(collection, options) {
	options = options == null ? {} : options;
	// TODO Bring from driver information in isMaster
	var maxBatchSizeBytes = 1024 * 1024 * 16;
	var maxBatchSizeDocuments = 10000;
	
	// Merge index
	var currentExecutionIndex = 0;
	var operationDocuments = [];
	
	// Current operation
	var currentOperation = null;
	var currentOperationType = null;
	var bulkOperations = [];
	// Start index is always 0
	var indexes = [0];
	var currentTotalIndex = 0;

	// Current item
	var currentOp = null;

	// Handle to the bson serializer, used to calculate running sizes
  var db = collection.db;
	var bson = db.bson;
	var self = this;

  // Get the write concern
  var writeConcern = shared._getWriteConcern(collection, options);
	
  // Batch size
  var batchSize = 0;

	// Namespace for the operation
  var namespace = collection.collectionName;  
  var maxTimeMS = options.maxTimeMS;
  var db = collection.db;

  // Final results
  var finalResults = {
			ok: 1
		,	n: 0  	
  };

	// Insert a document
	this.insert = function(document) {
		return addToOperationsList(self, INSERT, document);
	}

	var getOrderedCommand = function(_self, _namespace, _docType, _operationDocuments) {
		// Set up the types of operation
		if(_docType == INSERT) {
			return {
					insert: _namespace
				, documents: _operationDocuments
				, ordered:true 
			}
		} else if(_docType == UPDATE) {
			return {
					update: _namespace
				, updates: _operationDocuments
				, ordered:true
			};
		} else if(_docType == REMOVE) {
			return {
					delete: _namespace
				, deletes: _operationDocuments
				, ordered:true
			};
		}		
	}

	// Add to internal list of documents
	var addToOperationsList = function(_self, docType, document) {
		var size = bson.calculateObjectSize(document, false);

		// If a different document type than original push back the operations
		if(docType != currentOperationType) {
			
			// Push the current operation to the list for execution
			if(currentOperation != null) {
				bulkOperations.push(currentOperation);
				currentTotalIndex += operationDocuments.length;
				indexes.push(currentTotalIndex);
			}
			
			// Var documents
			operationDocuments = [];

			// Create a new type
			currentOperationType = docType;

			// Set up current write operation			
			currentOperation = getOrderedCommand(_self, namespace, docType, operationDocuments);

			// Create a new type
			currentOperation.writeConcern = writeConcern;
			
			// Set the batch Size
			batchSize = size;

			// Push the operation
			operationDocuments.push(document)
			
			// Return self
			return _self;
		}

		// List of the operations
		if((operationDocuments.length > maxBatchSizeDocuments)
			|| (batchSize > maxBatchSizeBytes)) {

			// Push the operation to the list
			bulkOperations.push(currentOperation);
			currentTotalIndex += operationDocuments.length;
			indexes.push(currentTotalIndex);

			// Set the size
			batchSize = size;

			// Var documents
			operationDocuments = [];

			// Create a new type
			currentOperationType = docType;

			// Set up current write operation			
			currentOperation = getOrderedCommand(_self, namespace, docType, operationDocuments);

			// Create a new type
			currentOperation.writeConcern = writeConcern;
		}

		// Update the batchSize list
		batchSize += size;
		// Push the operation to the list
		operationDocuments.push(document);
		// Return for chaining
		return _self;
	}

	// 
	// All operations chained to a find
	//
	var findOperations = {
		update: function(updateDocument) {
			// Perform upsert
			var upsert = typeof currentOp.upsert == 'boolean' ? currentOp.upsert : false;
			
			// Establish the update command
			var document = {
					q: currentOp.selector
				, u: updateDocument
				, multi: true
				, upsert: upsert
			}

			// Clear out current Op
			currentOp = null;
			// Add the update document to the list
			return addToOperationsList(self, UPDATE, document);
		},

		updateOne: function(updateDocument) {
			// Perform upsert
			var upsert = typeof currentOp.upsert == 'boolean' ? currentOp.upsert : false;
			
			// Establish the update command
			var document = {
					q: currentOp.selector
				, u: updateDocument
				, multi: false
				, upsert: upsert
			}

			// Clear out current Op
			currentOp = null;
			// Add the update document to the list
			return addToOperationsList(self, UPDATE, document);
		},

		replaceOne: function(updateDocument) {
			findOperations.updateOne(updateDocument);
		},

		upsert: function() {
			currentOp.upsert = true;
			// Return the findOperations
			return findOperations;
		},

		removeOne: function() {		
			// Establish the update command
			var document = {
					q: currentOp.selector
				, limit: 1
			}

			// Clear out current Op
			currentOp = null;
			// Add the remove document to the list
			return addToOperationsList(self, REMOVE, document);
		},

		remove: function() {
			// Establish the update command
			var document = {
					q: currentOp.selector
				, limit: 0
			}

			// Clear out current Op
			currentOp = null;
			// Add the remove document to the list
			return addToOperationsList(self, REMOVE, document);				
		}
	}

	//
	// Find selector
	this.find = function(selector) {
		// Save a current selector
		currentOp = {
			selector: selector
		}

		return findOperations;
	}

	//
	// Execute next write command in a chain
	var executeCommands = function(context, callback) {
		if(context.commands.length == 0) {
			return callback(null, finalResults);
		}

		// Ordered execution of the command
		var command = context.commands.shift();
		var startIndex = indexes.shift();
		
		// Execute it
		db.command(command, function(err, result) {			
			// If we have a single error, we have a single batch of one error
			if(err != null || (result != null && Array.isArray(result.errDetails))) {
				finalResults.ok = 0;
				finalResults.n += err.n;
				finalResults.errCode = err.errCode;
				finalResults.errmsg = err.errmsg;
				finalResults.errDetails = Array.isArray(finalResults.errDetails) ? finalResults.errDetails : []
				
				// Single error case merge in the result
				if(err != null && err.errDetails == null) {
					// Merge in the single error
					finalResults.errDetails.push({
							index: startIndex
						,	errCode: err.errCode
						, errmsg: err.errmsg
					})
				} else {
					var errDetails = err && err.errDetails ? err.errDetails : result.errDetails;
					// Let's traverse all the error details and merge them in
					for(var i = 0; i < errDetails.length; i++) {
						finalResults.errDetails.push({
								index: (startIndex + errDetails[i].index)
							,	errCode: err.errCode
							, errmsg: err.errmsg
						});
					}
				}
			} else if(result != null) {
				finalResults.n += result.n;
			}

			//
			// Merge any upserted values
			if(result != null && Array.isArray(result.upserted)) {
				// Ensure upserted results are correct
				finalResults.upserted = Array.isArray(finalResults.upserted) ? finalResults.upserted : [];
				// Merge in all the upserted items rewriting the index
				for(var i = 0; i < result.upserted.length; i++) {
					finalResults.upserted.push({
							index: (startIndex + result.upserted[i].index)
						,	_id: result.upserted[i]._id
					})
				}
			} else if(result != null && result.upserted != null) {
				finalResults.upserted.push({
						index: (startIndex + result.upserted.index)
					,	_id: result.upserted._id
				})				
			}

			// It's an ordered batch if there is an error terminate
			if(finalResults.ok == 0) {
				return callback(null, finalResults);
			}

			// Execute the next command in line
			executeCommands(context, callback);
		});
	}

	//
	// Execute the bulk operation
	this.execute = function(callback) {
		if(currentOperation != null) {
			bulkOperations.push(currentOperation);
			currentTotalIndex += operationDocuments.length;
			indexes.push(currentTotalIndex);
		}
		
		// Context for execution of all the commands
		var context = {
			commands: bulkOperations
		};

		// Execute all the commands
		executeCommands(context, callback);
	}
}

/**
 * Returns an unordered batch object
 *
 */
var initializeOrderedBulkOp = function(options) {
	return new OrderedBulkOperation(this, options);
}

exports.initializeOrderedBulkOp = initializeOrderedBulkOp;
