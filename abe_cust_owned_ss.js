/**
 * API Version 2.1
 * Issue: NetSuite internal ID field for HubSpot sync
 * Support Ticket: 2116
 *
 *          Created, Maintained, and Owned By Zastro
 *
 * Version    Date            Author           Remarks          Type
 * 1.00      8/1/22        Alex Gjorvad                       Scheduled
 *
/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 */
define(['N/search', 'N/runtime', 'N/record', 'N/task', 'N/file', 'N/email', 'N/render', 'N/config', 'N/format', 'N/xml'],
    function (search, runtime, record, task, file, email, render, config, format, xml) {

        function execute(scriptContext) {
            var scriptObj = runtime.getCurrentScript();
            log.debug('script start', scriptObj.id);

            var fulfillmentId = scriptObj.getParameter({
                name: 'custscript_iful_id'
            });
            log.debug('fulfillment_id', fulfillmentId);

            var fulfillment = record.load({
                type: 'itemfulfillment',
                id: fulfillmentId
            });

            var location = 9;

            var hasRun = fulfillment.getValue({
                fieldId: 'custbody_abe_ia'
            });
            var createdFrom = fulfillment.getValue({
                fieldId: 'createdfrom'
            });
            var ifulEntity = fulfillment.getValue({
                fieldId: 'entity'
            });

            // Load the original sales order and retrieve the Project Coordinator
            var origSalesOrd = record.load({
                type: 'salesorder',
                id: createdFrom
            });
            var projectCoordinator = origSalesOrd.getValue({
                fieldId: 'custbody_project_coordinator'
            });
            log.debug('project_coordinator', projectCoordinator);

            // Verify the retrieved value
            if (!projectCoordinator || isNaN(projectCoordinator)) {
                throw new Error('Invalid Project Coordinator ID: ' + projectCoordinator);
            }

            if (!hasRun) {
                var itemArray = getShippedItems(fulfillment);
                log.debug('itemArray', itemArray);

                var returnedAdjustment = createInvAdjustment(itemArray, location, fulfillmentId);
                log.debug('returnedAdjustment', returnedAdjustment);

                fulfillment.setValue({
                    fieldId: 'custbody_abe_ia',
                    value: returnedAdjustment
                });

                var returnOrder = findSO(ifulEntity, createdFrom, itemArray, projectCoordinator);
                log.debug('returnOrder', returnOrder);

                var invAdjid = record.submitFields({
                    type: 'inventoryadjustment',
                    id: returnedAdjustment,
                    values: {
                        'custbody_abe_so': returnOrder
                    }
                });
                log.debug('inventory_adjustment_id', invAdjid);

                var soId = record.submitFields({
                    type: 'salesorder',
                    id: createdFrom,
                    values: {
                        'custbody_abe_so': returnOrder,
                        'custbody_project_coordinator': projectCoordinator // Set the Project Coordinator field with the valid ID
                    }
                });
                log.debug('orig_so_id', soId);

                fulfillment.save();
            }
            log.debug('remaining_usage_at_end', scriptObj.getRemainingUsage());
        }

        const getShippedItems = (fulfillment) => {
            var numLines = fulfillment.getLineCount({
                sublistId: 'item'
            });
            if (numLines > 0) {
                var itemArray = [];
                for (var l = 0; l < numLines; l++) {
                    var ordItem = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: l
                    });
                    var itemText = fulfillment.getSublistText({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: l
                    });
                    var lineKey = fulfillment.getSublistValue({
                       sublistId: 'item',
                       fieldId: 'custcol_unique_key_link',
                       line: l
                    });
                    var ordQty = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: l
                    });
                    var ordRate = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        line: l
                    });
                    var sellRate = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemunitprice',
                        line: l
                    });
                    var itemT = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemtype',
                        line: l
                    });
                    var roomLocation = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_pr_room_location',
                        line: l
                    });
                    var detailAvailable = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'inventorydetailavail',
                        line: l
                    });
                    var subrec = fulfillment.getSublistSubrecord({
                        sublistId: 'item',
                        fieldId: 'inventorydetail',
                        line: l
                    });
                    var subNum = subrec.getLineCount({
                        sublistId: 'inventoryassignment'
                    });
                    var binNumberArray = [];
                    var binQtyArray = [];
                    for (var d = 0; d < subNum; d++) {
                        var binNumber = subrec.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            line: d
                        });
                        var binQty = subrec.getSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            line: d
                        });
                        binNumberArray.push(binNumber);
                        binQtyArray.push(binQty);
                    }
                    log.debug('select line in sub', 1);

                    var itemObj = new Object();
                    itemObj.ordItem = ordItem;
                    itemObj.itemT = itemT;
                    itemObj.ordQty = ordQty;
                    itemObj.lineKey = lineKey;
                    itemObj.roomLocation = roomLocation;
                    itemObj.binNumber = binNumberArray;
                    itemObj.binQty = binQtyArray;
                    itemArray.push(itemObj);
                }
                return itemArray;
            }
        };

        const createInvAdjustment = (itemArray, location, fulfillmentId) => {
            var invAdj = record.create({
                type: 'inventoryadjustment',
                isDynamic: true
            });
            invAdj.setValue({
                fieldId: 'subsidiary',
                value: 2
            });
            invAdj.setValue({
                fieldId: 'adjlocation',
                value: location
            });
            invAdj.setValue({
                fieldId: 'custbody_abe_iful',
                value: fulfillmentId
            });
            invAdj.setValue({
                fieldId: 'account',
                value: 357
            });
            for (let i = 0; i < itemArray.length; i++) {
                var ordItem = itemArray[i].ordItem;
                var ordQty = itemArray[i].ordQty;
                var binNumber = itemArray[i].binNumber;
                var binQty = itemArray[i].binQty;
                var itemT = itemArray[i].itemT;
                if (itemT == 'InvtPart') {
                    log.debug('binNumber', JSON.stringify(binNumber));
                    invAdj.selectNewLine({
                        sublistId: 'inventory'
                    });
                    invAdj.setCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'item',
                        value: ordItem
                    });
                    invAdj.setCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'adjustqtyby',
                        value: ordQty
                    });
                    invAdj.setCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'location',
                        value: location
                    });
                    invAdj.setCurrentSublistValue({
                        sublistId: 'inventory',
                        fieldId: 'unitcost',
                        value: 0.00
                    });
                    var subrec = invAdj.getCurrentSublistSubrecord({
                        sublistId: 'inventory',
                        fieldId: 'inventorydetail'
                    });
                    for (var x = 0; x < binNumber.length; x++) {
                        var returnedBinToUse = getNewBin(binNumber[x]);
                        log.debug('returnedBinToUse', returnedBinToUse);
                        var singleBinQty = binQty[x];
                        subrec.selectNewLine({
                            sublistId: 'inventoryassignment'
                        });
                        log.debug('select line in sub', 1);
                        subrec.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'binnumber',
                            value: returnedBinToUse
                        });
                        subrec.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'quantity',
                            value: singleBinQty
                        });
                        log.debug('commit line in sub - set number', 1);
                        subrec.commitLine({
                            sublistId: 'inventoryassignment'
                        });
                    }
                    log.debug('commit line - created sub', 1);
                    invAdj.commitLine({
                        sublistId: 'inventory'
                    });
                }
            }
            var savedAdjustment = invAdj.save();
            return savedAdjustment;
        };

        const findSO = (ifulEntity, createdFrom, itemArray, projectCoordinator) => {
            var origSalesOrd = record.load({
                type: 'salesorder',
                id: createdFrom,
                isDynamic: true
            });
            var poNum = origSalesOrd.getValue({
                fieldId: 'otherrefnum'
            });
            var soLoc = origSalesOrd.getValue({
                fieldId: 'location'
            });
            var searchResult = checkOpenOrder(ifulEntity, createdFrom);
            if (!searchResult) {
                var fieldLookUp = search.lookupFields({
                    type: 'customer',
                    id: ifulEntity,
                    columns: ['parent', 'entityid']
                });
                var parent = fieldLookUp.parent;
                var entityName = fieldLookUp.entityid;
                log.debug('parent_lookup', parent[0].value);
                log.debug('entity_name', entityName);

                var salesOrd = record.create({
                    type: 'salesorder',
                    isDynamic: true
                });
                salesOrd.setValue({
                    fieldId: 'customform',
                    value: 174
                });
                salesOrd.setValue({
                    fieldId: 'entity',
                    value: ifulEntity
                });
                salesOrd.setValue({
                    fieldId: 'class',
                    value: '7'
                });
                salesOrd.setValue({
                    fieldId: 'location',
                    value: 9
                });
                salesOrd.setValue({
                    fieldId: 'salesrep',
                    value: 4
                });
              
                // Set the Project Coordinator on the Sales Order
                salesOrd.setValue({
                    fieldId: 'custbody_project_coordinator',
                    value: projectCoordinator
                });

                if (parent[0].value != ifulEntity) {
                    var custOwned = 'Customer Owned ' + entityName;
                    var length = 44;
                    var trimmedString = custOwned.substring(0, length);
                    salesOrd.setValue({
                        fieldId: 'otherrefnum',
                        value: trimmedString
                    });
                } else {
                    salesOrd.setValue({
                        fieldId: 'otherrefnum',
                        value: poNum + ' Customer Owned'
                    });
                }
            } else {
                var salesOrd = record.load({
                    type: 'salesorder',
                    id: searchResult,
                    isDynamic: true
                });
                salesOrd.setValue({
                    fieldId: 'custbody_project_coordinator',
                    value: projectCoordinator
                });
            }
            for (let i = 0; i < itemArray.length; i++) {
                var ordItem = itemArray[i].ordItem;
                var ordQty = itemArray[i].ordQty;
                var itemT = itemArray[i].itemT;
                var roomLoc = itemArray[i].roomLocation;
                var lineKey = itemArray[i].lineKey;
                if (itemT == 'InvtPart') {
                    salesOrd.selectNewLine({
                        sublistId: 'item'
                    });
                    salesOrd.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        value: ordItem
                    });
                    log.debug('ord_qty', ordQty);
                    salesOrd.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        value: ordQty
                    });
                    /*salesOrd.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        value: 9
                    });*/
                    salesOrd.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_pr_room_location',
                        value: roomLoc
                    });
                    salesOrd.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'price',
                        value: ' '
                    });
                    salesOrd.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        value: 0.00
                    });
                    if (lineKey) {
                      salesOrd.setCurrentSublistValue({
                          sublistId: 'item',
                          fieldId: 'custcol_unique_key_link',
                          value: lineKey
                      });
                    }
                    salesOrd.commitLine({
                        sublistId: 'item'
                    });
                }
            }
            try {
                var multiSelectData = salesOrd.getValue({
                    fieldId: 'custbody_pre_live_inventory_order'
                });
                log.debug('pre_live_order_array', multiSelectData);
                multiSelectData.push(createdFrom);
                log.debug('post_live_order_array', multiSelectData);
                salesOrd.setValue({
                    fieldId: 'custbody_pre_live_inventory_order',
                    value: multiSelectData
                });
            } catch (e) {
                log.debug('error_on_multiselect', e.message);
            }
            var rec = salesOrd.save();
            return rec;
        };

        const checkOpenOrder = (ifulEntity, createdFrom) => {
            var returnId = '';
            var salesorderSearchObj = search.create({
                type: "salesorder",
                filters:
                    [
                        ["type", "anyof", "SalesOrd"],
                        "AND",
                        ["customform", "anyof", "174"],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["status", "anyof", "SalesOrd:A", "SalesOrd:B", "SalesOrd:D", "SalesOrd:E", "SalesOrd:F", "SalesOrd:G"],
                        "AND",
                        ["name", "anyof", ifulEntity]
                    ],
                columns:
                    [
                        "internalid"
                    ]
            });
            var searchResultCount = salesorderSearchObj.runPaged().count;
            log.debug("salesorderSearchObj result count", searchResultCount);
            salesorderSearchObj.run().each(function (result) {
                var id = result.getValue({
                    name: 'internalid'
                });
                returnId = id;
                return true;
            });
            return returnId;
        };

        const getNewBin = (binNumber) => {
            var binRec = record.load({
                type: 'bin',
                id: binNumber
            });
            var returnBin = binRec.getValue({
                fieldId: 'custrecord1'
            });
            if (!returnBin || returnBin == null) {
                returnBin = 2;
            }
            return returnBin;
        };

        return {
            execute: execute
        };
    });
