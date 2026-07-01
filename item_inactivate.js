/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * PREMIER LIGHTING - LEGACY ITEM INACTIVATION
 *
 * Inactivates every item returned by the saved search. That search IS the
 * candidate definition and the safety boundary. Reversible: records are
 * inactivated, not deleted. Run 2022, then repoint the search to 2023, then stop.
 *
 * NOTE: the summarize() below is a TEMPORARY diagnostic. The map/reduce
 * framework captures any getInputData/map/reduce exception into the summary
 * object instead of the execution log; with no summarize, that error is never
 * surfaced. This logs it so we can see why the run fails. Remove summarize
 * (and N/runtime) once the cause is identified.
 */
define(['N/search', 'N/record'], function (search, record) {

    const SEARCH_ID = 'customsearch_item_inactivate';

    function getInputData() {
        return search.load({ id: SEARCH_ID });
    }

    function map(context) {
        const itemId = JSON.parse(context.value).id;
        record.submitFields({
            type: record.Type.INVENTORY_ITEM,
            id: itemId,
            values: { isinactive: true },
            options: { enablesourcing: false, ignoreMandatoryFields: true }
        });
    }

    // --- TEMPORARY DIAGNOSTIC: surfaces the framework-captured error ---
    function summarize(summary) {
        if (summary.inputSummary && summary.inputSummary.error) {
            log.error({ title: 'getInputData ERROR', details: summary.inputSummary.error });
        }
        let mapErrors = 0;
        summary.mapSummary.errors.iterator().each(function (key, error) {
            if (mapErrors < 10) { log.error({ title: 'map ERROR (item ' + key + ')', details: error }); }
            mapErrors++;
            return true;
        });
        if (mapErrors) { log.audit({ title: 'TOTAL map errors', details: mapErrors }); }
        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error({ title: 'reduce ERROR key ' + key, details: error });
            return true;
        });
    }
    // --- end diagnostic ---

    return { getInputData: getInputData, map: map, summarize: summarize };
});