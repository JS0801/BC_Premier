/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Maintains the Materials Presently Stored (MPS) running balance on Invoice
 * and Sales Order lines, based on the Current Portion Stored Material (CPSM)
 * field on Invoice lines.
 *
 * CPSM can be POSITIVE (adding to storage) or NEGATIVE (withdrawing from storage).
 * MPS for a line on an invoice = prior invoice's MPS for that line + CPSM on this invoice.
 *
 * After every save, the SO's MPS column is synced to the latest invoice's MPS values.
 */

define(['N/search', 'N/record', 'N/log', 'N/error'], function (search, record, log, error) {

const FLD_CPSM = 'custcol_bc_curr_portion_stored_mat';
const FLD_MPS  = 'custcol_bc_materials_present_stored';

// Shared line-match key. On the Sales Order, this script stamps each line's
// lineuniquekey into this custom column; the value copies forward to the Item
// Fulfillment and Invoice lines, so all three records can be matched on it.
const LINE_KEY = 'custcol_line_unique_key';

// BODY field on the Item Fulfillment that records which Invoice consumed it.
// >>> REPLACE with the real internal id of your IF custom field. <<<
// Assumed to be a List/Record (Invoice) field. If it is a free-text/integer
// field instead, change the '@NONE@' filters to 'isempty' and clear with null.
const FLD_IF_INVOICE = 'custbody_bc_consumed_by_invoice';

/**
 * Get the latest mainline invoice ID for a given Sales Order.
 * Optionally exclude a specific invoice ID.
 *
 * @param {number|string} createdFrom - Sales Order internal ID
 * @param {number|string} [excludeId] - Invoice ID to exclude from the search
 * @returns {number} The latest invoice ID, or 0 if none found
 */
function findLatestMainlineInvId(createdFrom, excludeId) {
  const filters = [
    ['createdfrom', 'anyof', createdFrom],
    'AND', ['mainline', 'is', 'T']
  ];
  if (excludeId) {
    filters.push('AND', ['internalid', 'noneof', String(excludeId)]);
  }
  let latestId = 0;
  search.create({
    type: search.Type.INVOICE,
    filters,
    columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
  }).run().each(function (r) {
    latestId = +(r.getValue('internalid') || 0);
    return false;
  });
  return latestId;
}

/**
 * Find the Item Fulfillments that belong to THIS invoice's billing period.
 *
 * An IF "belongs" to an invoice if it has not yet been consumed by any other
 * invoice (its FLD_IF_INVOICE is empty), or if it was already stamped with
 * this same invoice (so re-saving the invoice is idempotent). This is how the
 * "fulfillments created since the previous invoice" window is enforced:
 * once an invoice consumes a set of IFs, they are stamped and excluded from
 * the next invoice's calculation.
 *
 * @param {number|string} soId - Sales Order internal ID
 * @param {number|string} [thisInvId] - Current invoice ID (0/blank on create)
 * @returns {number[]} Array of Item Fulfillment internal IDs to consolidate
 */
function findFulfillmentsToConsolidate(soId, thisInvId) {
  const consumedFilter = thisInvId
    ? [
        [FLD_IF_INVOICE, 'anyof', '@NONE@'],
        'OR', [FLD_IF_INVOICE, 'anyof', String(thisInvId)]
      ]
    : [FLD_IF_INVOICE, 'anyof', '@NONE@'];

  const ids = [];
  search.create({
    type: search.Type.ITEM_FULFILLMENT,
    filters: [
      ['createdfrom', 'anyof', soId],
      'AND', ['mainline', 'is', 'T'],
      'AND', consumedFilter
    ],
    columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
  }).run().each(function (r) {
    ids.push(+(r.getValue('internalid') || 0));
    return true;
  });
  log.debug('findFulfillmentsToConsolidate',
    'SO=' + soId + ' thisInv=' + (thisInvId || '(new)') + ' -> IFs=[' + ids.join(',') + ']');
  return ids;
}

/**
 * Build a map of line number -> TOTAL fulfilled quantity across the given
 * fulfillments (consolidates 2+ IFs into a single per-line quantity).
 *
 * @param {number[]} ifIds - Item Fulfillment internal IDs
 * @returns {object} Map keyed by line number with summed quantities
 */
function getConsolidatedQtyMap(ifIds) {
  const map = {};
  if (!ifIds || !ifIds.length) return map;
  search.create({
    type: 'transaction',
    filters: [
      ['internalid', 'anyof', ifIds.map(String)],
      'AND', [LINE_KEY,    'isnotempty', '']
    ],
    columns: [LINE_KEY, 'quantity']
  }).run().each(function (r) {
    const ln  = r.getValue(LINE_KEY);
    const qty = Math.abs(+(r.getValue('quantity') || 0));
    if (ln) map[ln] = (map[ln] || 0) + qty;
    return true;
  });
  log.debug('getConsolidatedQtyMap', 'IFs=[' + ifIds.join(',') + '] qtyByLine=' + JSON.stringify(map));
  return map;
}

/**
 * Stamp the consuming-invoice field on each fulfillment.
 *
 * @param {number[]} ifIds - Item Fulfillment internal IDs
 * @param {number|string} invId - Invoice internal ID to stamp (or '' to clear)
 */
function stampFulfillments(ifIds, invId) {
  (ifIds || []).forEach(function (ifId) {
    if (!ifId) return;
    try {
      const values = {};
      values[FLD_IF_INVOICE] = invId === '' ? '' : String(invId);
      record.submitFields({
        type: record.Type.ITEM_FULFILLMENT,
        id: ifId,
        values: values,
        options: { ignoreMandatoryFields: true }
      });
      log.audit('stampFulfillments',
        'IF ' + ifId + ' -> ' + (invId === '' ? 'CLEARED' : 'Invoice ' + invId));
    } catch (e) {
      log.error('stampFulfillments failed', ifId + ' -> ' + invId + ' : ' + e);
    }
  });
}

/**
 * Find every fulfillment currently stamped with a given invoice.
 *
 * @param {number|string} invId - Invoice internal ID
 * @returns {number[]} Array of Item Fulfillment internal IDs
 */
function findFulfillmentsStampedWith(invId) {
  const ids = [];
  if (!invId) return ids;
  search.create({
    type: search.Type.ITEM_FULFILLMENT,
    filters: [
      ['mainline', 'is', 'T'],
      'AND', [FLD_IF_INVOICE, 'anyof', String(invId)]
    ],
    columns: ['internalid']
  }).run().each(function (r) {
    ids.push(+(r.getValue('internalid') || 0));
    return true;
  });
  return ids;
}

/**
 * Build a map of line number -> rate for a Sales Order.
 *
 * @param {number|string} soId - Sales Order internal ID
 * @returns {object} Map keyed by line number with line rates
 */
function getLineRateMapForSO(soId) {
  if (!soId) return {};
  const map = {};
  search.create({
    type: 'transaction',
    filters: [
      ['internalid', 'anyof', String(soId)],
      'AND', ['mainline',  'is', 'F'],
      'AND', ['taxline',   'is', 'F'],
      'AND', ['shipping',  'is', 'F'],
      'AND', [LINE_KEY,    'isnotempty', '']
    ],
    columns: [LINE_KEY, 'rate']
  }).run().each(function (r) {
    const ln   = r.getValue(LINE_KEY);
    const rate = r.getValue('rate');
    if (ln) map[ln] = +(rate || 0);
    return true;
  });
  return map;
}

/**
 * Build a map of line number -> MPS for an invoice.
 *
 * @param {number|string} invId - Invoice internal ID
 * @returns {object} Map keyed by line number with MPS values
 */
function getLineMpsMapForInvoice(invId) {
  if (!invId) return {};
  const map = {};
  search.create({
    type: 'transaction',
    filters: [
      ['internalid', 'anyof', String(invId)],
      'AND', ['mainline',  'is', 'F'],
      'AND', ['taxline',   'is', 'F'],
      'AND', ['shipping',  'is', 'F'],
      'AND', [LINE_KEY,    'isnotempty', '']
    ],
    columns: [LINE_KEY, FLD_MPS]
  }).run().each(function (r) {
    const ln  = r.getValue(LINE_KEY);
    const val = r.getValue(FLD_MPS);
    if (ln) map[ln] = +(val || 0);
    return true;
  });
  return map;
}

/**
 * Build a map of line number -> stored-material fields from a loaded record.
 *
 * @param {Record} rec - Invoice record
 * @returns {object} Map keyed by line number
 */
function getStoredMaterialLineMap(rec) {
  const map = {};
  const lineCount = rec.getLineCount({ sublistId: 'item' });

  for (let i = 0; i < lineCount; i++) {
    const lineNum = rec.getSublistValue({
      sublistId: 'item', fieldId: LINE_KEY, line: i
    });
    if (!lineNum) continue;

    map[lineNum] = {
      cpsm: +(rec.getSublistValue({
        sublistId: 'item', fieldId: FLD_CPSM, line: i
      }) || 0),
      mps: +(rec.getSublistValue({
        sublistId: 'item', fieldId: FLD_MPS, line: i
      }) || 0)
    };
  }

  return map;
}

/**
 * @param {number} a
 * @param {number} b
 */
function sameCurrencyAmount(a, b) {
  return Math.abs((+a || 0) - (+b || 0)) < 0.005;
}

/**
 * Throw if an edit to a non-latest invoice changes CPSM or MPS.
 *
 * @param {Record} oldRec
 * @param {Record} newRec
 */
function assertStoredMaterialsUnchanged(oldRec, newRec) {
  const oldMap = getStoredMaterialLineMap(oldRec);
  const newMap = getStoredMaterialLineMap(newRec);

  for (const lineNum in newMap) {
    const oldVals = oldMap[lineNum] || { cpsm: 0, mps: 0 };
    const newVals = newMap[lineNum];

    if (!sameCurrencyAmount(oldVals.cpsm, newVals.cpsm) ||
        !sameCurrencyAmount(oldVals.mps, newVals.mps)) {
      throw error.create({
        name: 'BC_STORED_MATERIALS_LOCKED',
        message: 'Stored-material fields can only be changed on the latest invoice for this Sales Order.',
        notifyOff: false
      });
    }
  }

  for (const lineNum in oldMap) {
    if (newMap[lineNum]) continue;
    if (!sameCurrencyAmount(oldMap[lineNum].cpsm, 0) ||
        !sameCurrencyAmount(oldMap[lineNum].mps, 0)) {
      throw error.create({
        name: 'BC_STORED_MATERIALS_LOCKED',
        message: 'Stored-material lines can only be removed from the latest invoice for this Sales Order.',
        notifyOff: false
      });
    }
  }
}

/**
 * Sales Order side: copy each line's lineuniquekey into LINE_KEY so the value
 * carries forward to Item Fulfillment and Invoice lines. Reloaded because
 * lineuniquekey isn't assigned until the record is saved.
 *
 * @param {number|string} soId - Sales Order internal ID
 */
function stampSalesOrderLineKeys(soId) {
  const so = record.load({
    type: record.Type.SALES_ORDER,
    id: soId,
    isDynamic: false
  });

  let changed = false;
  const count = so.getLineCount({ sublistId: 'item' });
  for (let i = 0; i < count; i++) {
    const key = so.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });
    const cur = so.getSublistValue({ sublistId: 'item', fieldId: LINE_KEY, line: i });
    if (key && String(cur) !== String(key)) {
      so.setSublistValue({ sublistId: 'item', fieldId: LINE_KEY, line: i, value: key });
      changed = true;
    }
  }

  // Only save when something changed (also prevents the save from looping back).
  if (changed) {
    so.save({ ignoreMandatoryFields: true });
    log.audit('SO line keys stamped', 'Sales Order ' + soId);
  }
}

/**
 * Before Submit: recalculate MPS on this invoice's lines, or on DELETE,
 * roll the SO's MPS back to the latest remaining invoice.
 *
 * @param {object} context - User Event context
 */
function beforeSubmit(context) {
  try {
    const rec = context.newRecord;
    if (rec.type !== record.Type.INVOICE) return;

    log.audit('beforeSubmit START',
      'eventType=' + context.type + ' invoiceId=' + (rec.id || '(new)'));

    // === DELETE: subtract this invoice's CPSM from the SO's MPS total, and
    //     release the fulfillments it had consumed so they can be re-billed. ===
    if (context.type === context.UserEventType.DELETE) {
      const oldRec = context.oldRecord;
      if (!oldRec || oldRec.type !== record.Type.INVOICE) return;

      const createdFrom = oldRec.getValue({ fieldId: 'createdfrom' });
      if (!createdFrom) return;

      log.audit('beforeSubmit DELETE', 'invoiceId=' + oldRec.id + ' SO=' + createdFrom);

      // Per-line CPSM (and MPS) of the invoice being deleted
      const deletedMap = getStoredMaterialLineMap(oldRec);
      log.debug('DELETE deletedMap (cpsm/mps by line)', JSON.stringify(deletedMap));

      const so = record.load({
        type: record.Type.SALES_ORDER,
        id: createdFrom,
        isDynamic: false
      });

      // For each line on the deleted invoice, find the matching SO line by its
      // key value and subtract that line's CPSM from the SO's running MPS.
      Object.keys(deletedMap).forEach(function (lineKey) {
        const soLine = so.findSublistLineWithValue({
          sublistId: 'item', fieldId: LINE_KEY, value: lineKey
        });
        if (soLine === -1) {
          log.debug('DELETE no SO line', 'key=' + lineKey + ' not found on SO');
          return;
        }

        const deletedCpsm = +(deletedMap[lineKey].cpsm || 0);
        const currentMps  = +(so.getSublistValue({
          sublistId: 'item', fieldId: FLD_MPS, line: soLine
        }) || 0);
        const newMps = Math.round((currentMps - deletedCpsm) * 100) / 100;

        log.debug('DELETE roll-back key ' + lineKey + ' (SO line ' + soLine + ')',
          'SO MPS ' + currentMps + ' - CPSM ' + deletedCpsm + ' = ' + newMps);

        so.setSublistValue({
          sublistId: 'item', fieldId: FLD_MPS, line: soLine, value: newMps
        });
      });
      so.save({ ignoreMandatoryFields: true });
      log.audit('DELETE SO updated', 'SO=' + createdFrom);

      // Release the IFs this invoice had stamped so a future invoice re-bills them
      const releaseIds = findFulfillmentsStampedWith(oldRec.id);
      log.audit('DELETE releasing IFs', 'invoiceId=' + oldRec.id + ' IFs=[' + releaseIds.join(',') + ']');
      stampFulfillments(releaseIds, '');
      return;
    }

    // === CREATE / EDIT: recalc MPS on this invoice's lines ===
    const createdFrom = rec.getValue({ fieldId: 'createdfrom' });
    if (!createdFrom) {
      log.debug('beforeSubmit skip', 'No createdfrom (not from a Sales Order)');
      return;
    }

    let currentId = 0;
    if (rec.id) currentId = parseInt(rec.id, 10);

    // If editing an older invoice (not the latest), do not recalc — only the
    // latest invoice owns the MPS chain.
    const isEdit = context.type === context.UserEventType.EDIT;
    if (isEdit && currentId) {
      const latestIdForSO = findLatestMainlineInvId(createdFrom);
      if (latestIdForSO && latestIdForSO !== currentId) {
        log.audit('beforeSubmit skip recalc',
          'Editing non-latest invoice ' + currentId + ' (latest is ' + latestIdForSO + '); verifying locked fields unchanged');
        assertStoredMaterialsUnchanged(context.oldRecord, rec);
        return;
      }
    }

    // Find the prior invoice (latest before this one, if any)
    let latestPriorId;
    if (isEdit && currentId) {
      latestPriorId = findLatestMainlineInvId(createdFrom, currentId);
    } else {
      latestPriorId = findLatestMainlineInvId(createdFrom);
    }
    const priorMpsMap = getLineMpsMapForInvoice(latestPriorId);
    log.debug('beforeSubmit prior invoice',
      'SO=' + createdFrom + ' priorInvoiceId=' + (latestPriorId || 'none') +
      ' priorMpsByLine=' + JSON.stringify(priorMpsMap));

    // Auto-compute CPSM by consolidating every fulfillment in this invoice's
    // period (all IFs not yet consumed by another invoice):
    //   CPSM = (sum of fulfilled qty for this line across those IFs) * SO rate
    const ifIds          = findFulfillmentsToConsolidate(createdFrom, currentId);
    const fulfilledQtyMap = getConsolidatedQtyMap(ifIds);
    const soRateMap       = getLineRateMapForSO(createdFrom);
    log.debug('beforeSubmit SO rates', 'rateByLine=' + JSON.stringify(soRateMap));

    // Recalculate MPS for each line: MPS = priorMPS + CPSM
    const lineCount = rec.getLineCount({ sublistId: 'item' });
    for (let i = 0; i < lineCount; i++) {
      const lineNum = rec.getSublistValue({
        sublistId: 'item', fieldId: LINE_KEY, line: i
      });
      if (!lineNum) continue;

      // Derive CPSM automatically rather than reading a manual entry
      const fulfilledQty = +(fulfilledQtyMap[lineNum] || 0);
      const soRate       = +(soRateMap[lineNum] || 0);
      const cpsm = Math.round(fulfilledQty * soRate * 100) / 100;

      rec.setSublistValue({
        sublistId: 'item', fieldId: FLD_CPSM, line: i, value: cpsm
      });

      const priorMps = +(priorMpsMap[lineNum] || 0);
      const mps = priorMps + cpsm;

      log.debug('line ' + lineNum,
        'qty=' + fulfilledQty + ' x rate=' + soRate + ' => CPSM=' + cpsm +
        ' ; priorMPS=' + priorMps + ' + CPSM=' + cpsm + ' => MPS=' + mps);

      rec.setSublistValue({
        sublistId: 'item', fieldId: FLD_MPS, line: i, value: mps
      });
    }
    log.audit('beforeSubmit END', 'Recalculated ' + lineCount + ' line(s) on invoice ' + (currentId || '(new)'));
  } catch (e) {
    log.error('beforeSubmit error', (e && e.stack) ? e.stack : e);
  }
}

/**
 * After Submit: sync the SO's MPS column to this invoice's MPS values,
 * but only if this is the latest invoice for the SO.
 *
 * @param {object} context - User Event context
 */
function afterSubmit(context) {
  if (context.type === context.UserEventType.DELETE) return;

  try {
    const rec = context.newRecord;

    // Sales Order: just stamp the line-match keys, then done.
    if (rec.type === record.Type.SALES_ORDER) {
      stampSalesOrderLineKeys(rec.id);
      return;
    }

    if (rec.type !== record.Type.INVOICE) return;

    const createdFrom = rec.getValue('createdfrom');
    if (!createdFrom) return;

    log.audit('afterSubmit START',
      'eventType=' + context.type + ' invoiceId=' + rec.id + ' SO=' + createdFrom);

    const latestInvoiceId = findLatestMainlineInvId(createdFrom);
    if (parseInt(rec.id, 10) !== latestInvoiceId) {
      log.audit('afterSubmit skip',
        'Invoice ' + rec.id + ' is not the latest (' + latestInvoiceId + ') for SO ' + createdFrom + '; no SO sync/stamp');
      return;
    }

    const salesOrder = record.load({
      type: record.Type.SALES_ORDER,
      id: createdFrom,
      isDynamic: false
    });

    const invLineCount = rec.getLineCount({ sublistId: 'item' });

    // Build map of line key -> MPS from this invoice
    const invMap = {};
    for (let i = 0; i < invLineCount; i++) {
      const invLineNum = rec.getSublistValue({
        sublistId: 'item', fieldId: LINE_KEY, line: i
      });
      if (invLineNum) {
        invMap[invLineNum] = +(rec.getSublistValue({
          sublistId: 'item', fieldId: FLD_MPS, line: i
        }) || 0);
      }
    }

    // Apply to the matching SO line, located by its key value
    Object.keys(invMap).forEach(function (lineKey) {
      const soLine = salesOrder.findSublistLineWithValue({
        sublistId: 'item', fieldId: LINE_KEY, value: lineKey
      });
      if (soLine === -1) {
        log.debug('afterSubmit no SO line', 'key=' + lineKey + ' not found on SO');
        return;
      }
      salesOrder.setSublistValue({
        sublistId: 'item', fieldId: FLD_MPS, line: soLine, value: invMap[lineKey]
      });
    });

    salesOrder.save({ ignoreMandatoryFields: true });
    log.audit('afterSubmit SO synced',
      'SO=' + createdFrom + ' mpsByLine=' + JSON.stringify(invMap));

    // Stamp the fulfillments consolidated into this invoice so the next
    // invoice's calculation excludes them. Recomputed here (same selection
    // logic as beforeSubmit) because rec.id is now available.
    const consumedIfIds = findFulfillmentsToConsolidate(createdFrom, parseInt(rec.id, 10));
    log.audit('afterSubmit stamping IFs',
      'invoiceId=' + rec.id + ' IFs=[' + consumedIfIds.join(',') + ']');
    stampFulfillments(consumedIfIds, parseInt(rec.id, 10));
    log.audit('afterSubmit END', 'invoiceId=' + rec.id);
  } catch (e) {
    log.error('afterSubmit error', (e && e.stack) ? e.stack : e);
  }
}

  return {
    beforeSubmit: beforeSubmit,
    afterSubmit: afterSubmit
  };
});