/**
 * @NApiVersion 2.1
 * @NScriptType workflowactionscript
 */
define(['N/record', 'N/search', 'N/ui', 'N/ui/dialog', 'N/runtime', 'N/task'],
    /**
     * @param {record} record
     * @param {search} search
     * @param {ui} ui
     * @param {dialog} dialog
     * @param {runtime} runtime
     * @param {task} task
     */
    function (record, search, ui, dialog, runtime, task) {

        /**
         * Definition of the Suitelet script trigger point.
         *
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {Record} scriptContext.oldRecord - Old record
         * @Since 2016.1
         */
        function onAction(context) {
            var IFUL = context.newRecord
            var fulfillmentId = IFUL.id
            var hasRun = IFUL.getValue({
                fieldId: 'custbody_abe_ia'
            });
          log.debug('has_run?', hasRun);
          var shippingMethod = IFUL.getValue({
              fieldId: 'shipmethod'
          })
          var shipStatus = IFUL.getValue({
            fieldId: 'shipstatus'
        });
        log.debug('ship_status', shipStatus);
          if (!hasRun && shippingMethod == '452409' && shipStatus == 'C') {
            var scriptTask = task.create({ taskType: task.TaskType.SCHEDULED_SCRIPT });
            //script ID: customscript_evm_create_cash_sale_sched
            //SB script ID: scriptTask.scriptId = 707;
            scriptTask.scriptId = 1085;
            //Name of parameter on scheduled script record: File ID
            scriptTask.params = { custscript_iful_id: fulfillmentId };
            var scriptTaskId = scriptTask.submit();
            log.debug('script_task_id', scriptTaskId);
          }
            // var fulfillment = record.load({
            //     type: 'itemfulfillment',
            //     id: fulfillmentId,
            //     isDynamic: true
            // });

            // //log.debug('fulfillment', fulfillment)

            // //get the item and check the type
            // var shipMethod = fulfillment.getValue({
            //     fieldId: 'shipmethod'
            // });

            // var location = 7

            // var hasRun = fulfillment.getValue({
            //     fieldId: 'custbody_abe_ia'
            // });
            // var createdFrom = fulfillment.getValue({
            //     fieldId: 'createdfrom'
            // });
            // var ifulEntity = fulfillment.getValue({
            //     fieldId: 'entity'
            // });
            // log.debug(shipMethod, hasRun)
            // if (shipMethod == 5843 && !hasRun) {
            //     var itemArray = getShippedItems(fulfillment)
            //     log.debug('itemArray', itemArray)

            //     var returnedAdjustment = createInvAdjustment(itemArray, location, fulfillmentId)
            //     log.debug('returnedAdjustment', returnedAdjustment)

            //     fulfillment.setValue({
            //         fieldId: 'custbody_abe_ia',
            //         value: returnedAdjustment
            //     })
     
            //     var returnOrder = findSO(ifulEntity, createdFrom, itemArray)
            //     log.debug('returnOrder',returnOrder)
        
            //     var id = record.submitFields({
            //         type: 'inventoryadjustment',
            //         id: returnedAdjustment,
            //         values: {
            //             'custbodybody_abe_so': returnOrder
            //         }
            //     });
                
            //     fulfillment.save()
            // }
        }
        const findSO = (ifulEntity, createdFrom, itemArray) => {
            var salesOrd = record.load({
                type: 'salesorder',
                id: createdFrom,
                isDynamic: true
            })
            var poNum = salesOrd.getValue({
                fieldId: 'otherrefnum'
            })
            var searchResult = checkOpenOrder(ifulEntity, poNum)
            if (!searchResult) {
                var salesOrd = record.create({
                    type: 'salesorder',
                    isDynamic: true
                })
                salesOrd.setValue({
                    fieldId: 'entity',
                    value: ifulEntity
                })
                salesOrd.setValue({
                    fieldId: 'location',
                    value: 7
                })
                salesOrd.setValue({
                    fieldId: 'customform',
                    value: 120
                })
                salesOrd.setValue({
                    fieldId: 'otherrefnum',
                    value: poNum + ' Customer Owned'
                })
            }
            else {
                var salesOrd = record.load({
                    type: 'salesorder',
                    id: searchResult,
                    isDynamic: true
                })
            }
            for (let i = 0; i < itemArray.length; i++) {
                var ordItem = itemArray[i].ordItem
                var ordQty = itemArray[i].ordQty
                var binNumber = itemArray[i].binNumber
                var itemT = itemArray[i].itemT

                salesOrd.selectNewLine({
                    sublistId: 'item'
                });
                salesOrd.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    value: ordItem
                });
                salesOrd.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    value: ordQty
                });
                salesOrd.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    value: 7
                });
                salesOrd.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    value: 0.00
                });

                salesOrd.commitLine({
                    sublistId: 'item'
                });
            }
            var rec = salesOrd.save()
            //log.debug('rec',rec)
            return rec
        }

        const checkOpenOrder = (ifulEntity, poNum) => {
            var returnId = ''
            var salesorderSearchObj = search.create({
                type: "salesorder",
                filters:
                    [
                        ["type", "anyof", "SalesOrd"],
                        "AND",
                        ["customform", "anyof", "120"],
                        "AND",
                        ["otherrefnum", "equalto", poNum],
                        "AND",
                        ["mainline", "is", "T"],
                        "AND",
                        ["status", "anyof", "SalesOrd:A", "SalesOrd:B"],
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
                // .run().each has a limit of 4,000 results
                var id = result.getValue({
                    name: 'internalid'
                })
                returnId = id
                return true;
            });

            return returnId
        }


        const getShippedItems = (fulfillment) => {
            var numLines = fulfillment.getLineCount({
                sublistId: 'item'
            });
            if (numLines > 0) {
                var itemArray = new Array()
                for (var l = 0; l < numLines; l++) {
                    var ordItem = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: l
                    })
                    var itemText = fulfillment.getSublistText({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: l
                    })
                    var ordQty = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: l
                    })
                    var ordRate = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        line: l
                    })
                    var sellRate = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemunitprice',
                        line: l
                    })
                    var itemT = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemtype',
                        line: l
                    })
                    var roomLocation = fulfillment.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_pr_room_location',
                        line: l
                    })


                    // var detailAvailable = fulfillment.getSublistValue({
                    //     sublistId: 'item',
                    //     fieldId: 'inventorydetailavail',
                    //     line: l
                    // })
                    // var subrec = fulfillment.getSublistSubrecord({
                    //     sublistId: 'item',
                    //     fieldId: 'inventorydetail',
                    //     line: l
                    // });
                    // var subNum = subrec.getLineCount({
                    //     sublistId: 'inventoryassignment'  
                    // });
                    // for(var d=0; d<subNum; d++){
                    //     var binNumber = subrec.getSublistValue({
                    //         sublistId: 'inventoryassignment',
                    //         fieldId: 'binnumber',
                    //         line: d
                    //     });
                    // }
                    // log.debug('select line in sub', 1)

                    var ifulLineObj = new Object()
                    ifulLineObj.ordItem = ordItem
                    ifulLineObj.ordQty = ordQty
                    ifulLineObj.ordRate = ordRate
                    ifulLineObj.itemText = itemText
                    // ifulLineObj.binNumber = binNumber
                    ifulLineObj.sellRate = sellRate
                    ifulLineObj.itemT = itemT
                    ifulLineObj.roomLocation = roomLocation
                    itemArray.push(ifulLineObj)
                }
                return itemArray
            }
        }

        const billSalesOrder = (createdFrom, itemArray) => {
            var invObj = record.transform({
                fromType: 'salesorder',
                fromId: createdFrom,
                toType: 'invoice',
                isDynamic: true,
            });

            invObj.setValue({
                fieldId: 'custbody_pr_stored_inv',
                value: true
            });
            var numLines = invObj.getLineCount({
                sublistId: 'item'
            });
            log.debug('inv numLines', numLines)
            if (numLines > 0) {
                var indexCount = Number(numLines) - 1
                for (var l = indexCount; l >= 0; l--) {
                    var ordItem = invObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: l
                    })
                    log.debug('ordItem', ordItem)
                    var keepLine = false
                    for (var i = 0; i < itemArray.length; i++) {
                        var arrayItem = itemArray[i].ordItem
                        if (ordItem == arrayItem) {
                            log.debug('we have match')
                            keepLine = true
                        }
                    }
                    if (keepLine == false) {
                        log.debug('fail guess?')
                        invObj.removeLine({
                            sublistId: 'item',
                            line: l,
                            ignoreRecalc: true
                        });
                    }
                }
                var savedInvoice = invObj.save()
                return savedInvoice
            }
        }


        const createInvAdjustment = (itemArray, location, fulfillmentId) => {
            //log.debug('itemArray', itemArray)
            var invAdj = record.create({
                type: 'inventoryadjustment',
                isDynamic: true,
            })
            invAdj.setValue({
                fieldId: 'subsidiary',
                value: 2,
            });
            invAdj.setValue({
                fieldId: 'adjlocation',
                value: location,
            });
            invAdj.setValue({
                fieldId: 'custbody_abe_iful',
                value: fulfillmentId,
            });
            invAdj.setValue({
                fieldId: 'account',
                value: 55,
            });


            for (let i = 0; i < itemArray.length; i++) {
                var ordItem = itemArray[i].ordItem
                var ordQty = itemArray[i].ordQty
                var binNumber = itemArray[i].binNumber
                var itemT = itemArray[i].itemT
                if (itemT == 'InvtPart') {
                    //log.debug('binNumber', binNumber)
                    // var returnedBinToUse = getNewBin(binNumber)
                    var returnedBinToUse = 16
                    //log.debug('returnedBinToUse', returnedBinToUse)
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
                    subrec.selectNewLine({
                        sublistId: 'inventoryassignment'
                    });
                    //log.debug('select line in sub', 1)
                    subrec.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'binnumber',
                        value: returnedBinToUse
                    });
                    subrec.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        value: ordQty
                    });
                    //log.debug('commit line in sub - set number', 1)
                    subrec.commitLine({
                        sublistId: 'inventoryassignment'
                    });
                    //log.debug('commit line - created sub', 1)
                    invAdj.commitLine({
                        sublistId: 'inventory'
                    });
                }
            }
            var savedAdjustment = invAdj.save()
            return savedAdjustment
        }
        const getNewBin = (binNumber) => {
            var binRec = record.load({
                type: 'bin',
                id: binNumber
            });
            var returnBin = binRec.getValue({
                fieldId: 'custrecord1'
            })
            if (!returnBin || returnBin == null) {
                returnBin = 5
            }
            return returnBin
        }

        // const getNewBin = (binNumber) => {
        //     var returnBin;
        //     var binSearchObj = search.create({
        //         type: "bin",
        //         filters:
        //         [
        //            ["internalidnumber","equalto",binNumber]
        //         ],
        //         columns:
        //         [
        //            search.createColumn({
        //               name: "binnumber",
        //               sort: search.Sort.ASC
        //            })
        //         ]
        //      });
        //      var searchResultCount = binSearchObj.runPaged().count;
        //      log.debug("binSearchObj result count",searchResultCount);
        //      binSearchObj.run().each(function(result){
        //         // .run().each has a limit of 4,000 results
        //         var oldBin = result.getValue({
        //             name:'binnumber'
        //         })
        //         var dropSpace = oldBin.replace(/\s+/g, '')
        //         var newBin = 'SI-'+dropSpace
        //         var newBinId = getNewBinId(newBin)
        //         returnBin = newBinId
        //         return true;
        //      });
        //      return returnBin
        // }
        // const getNewBinId = (newBin) => {
        //     var returnBin;
        //     var binSearchObj = search.create({
        //         type: "bin",
        //         filters:
        //         [
        //            ["binnumber","is",newBin]
        //         ],
        //         columns:
        //         [
        //            "internalid"
        //         ]
        //      });
        //      var searchResultCount = binSearchObj.runPaged().count;
        //      log.debug("binSearchObj result count",searchResultCount);
        //      binSearchObj.run().each(function(result){
        //         // .run().each has a limit of 4,000 results
        //         var binId = result.getValue({
        //             name:'internalid'
        //         })
        //         returnBin = binId
        //         return true;
        //      });
        //      return returnBin
        // }
       
        return {
            onAction: onAction
        };

    });