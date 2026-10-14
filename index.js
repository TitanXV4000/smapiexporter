/* smapiexporter
Keeps one browser logged in to OTSM and reads cases from the SMAX EMS REST API
(replacing smexporter's QMON report export). Every INTERVAL it writes one JSON batch
to OUTPUT_PATH, as rows keyed by the report's column names (plus "Description" and
"Latest Comment"),
which smjsonparser imports into Mongo.
  - Cases changed since the previous batch, with Description and the latest comment
    (only these carry them; a new comment updates LastUpdateTime).
  - All open cases with no owner (the unassigned queue), without Description. Their SLT
    target can change without LastUpdateTime changing, and refreshing them every minute
    keeps logTime moving for the freshness checks (qmond: newest logTime; sf-notify via
    open.php: newest logTime of the unassigned queue) when no case changes for a while.
  - First start (no state file): all open cases plus closed ones updated in the last BACKFILL_DAYS.
Field mapping and findings: qmon/notes/otsm-api.md.
*/
const puppeteer = require('puppeteer');
const tsanfordLogger = require('tsanford-logger');
const fs = require('fs');
const path = require('path');

const logger = tsanfordLogger.newLogger();

const config = {
    URL: process.env.SM_URL,
    USER_LOGIN: process.env.USER_LOGIN,
    PASS: process.env.PASS,
    OUTPUT_PATH: process.env.OUTPUT_PATH || '/smexports-api',
    ARCHIVE_PATH: process.env.ARCHIVE_PATH || '',           // test runs: keep a copy of every batch
    INTERVAL: parseInt(process.env.REPORT_INTERVAL || '60000', 10),
    OVERLAP_MS: parseInt(process.env.OVERLAP_MS || '120000', 10),
    BACKFILL_DAYS: parseInt(process.env.BACKFILL_DAYS || '90', 10),
    PAGE_SIZE: parseInt(process.env.PAGE_SIZE || '1000', 10),
    BATCH_ROWS: parseInt(process.env.BATCH_ROWS || '1000', 10),
    MAX_FAILED_CYCLES: parseInt(process.env.MAX_FAILED_CYCLES || '5', 10),
    BACKLOG_LIMIT: parseInt(process.env.BACKLOG_LIMIT || '20', 10),   // unread batches before writing changes only
};
const STATE_DIR = path.join(config.OUTPUT_PATH, 'state');      // the parser only watches the top level
const STATE_FILE = path.join(STATE_DIR, 'api-state.json');
const BASE = config.URL.split('/reports/')[0];
const TENANT = (config.URL.match(/TENANTID=(\d+)/) || [])[1];
const EMS = entity => `${BASE}/rest/${TENANT}/ems/${entity}`;

// Request fields for one report row (related fields go one level deep). Matched against
// the QMON report's values: the report's "Requested for company" is the case's
// RequestToCompany, "Report location" is RegisteredForLocation, "Created On" is
// EmsCreationTime and "SLT.Next target time" is the SLT record's TargetDate.
const LAYOUT = [
    'Id', 'DisplayLabel', 'OwnedByPerson.Name', 'LastUpdateTime', 'CaseType_c', 'CreationSource', 'RequestedByPerson.Name',
    'EmsCreationTime', 'Status', 'ProductInstance.DisplayLabel', 'Priority', 'RequestedForPerson.Name',
    'RequestedForPerson.Email', 'RequestedForPerson.OfficePhoneNumber', 'RequestedForPerson.MobilePhoneNumber',
    'RequestedForPerson.TimeZone', 'FTSHostAccount_c', 'FTSHostPassword_c', 'ClosedDateTime_c', 'LastUpdatedBy_c.Name',
    'SLT.TargetDate', 'PhaseId', 'AssignedToGroup.Name', 'CompanyTimeZoneUser_c', 'FlexCreditCountry_c.DisplayLabel',
    'ProductDevID_c', 'ProductModel_c.DisplayLabel', 'ClosureCode_c.DisplayLabel', 'ResolvedDateTime_c', 'CloseTime',
    'RequestToCompany.DisplayLabel', 'RequestToCompany.TimeZone', 'RequestToCompany.CompanyTimeZoneUser_c', 'RequestToCompany.RoutingRegion_c',
    'RegisteredForLocation.DisplayLabel', 'RegisteredForLocation.DisplayName',
].join(',');
const DETAIL_LAYOUT = LAYOUT + ',Description,LatestComment_c';   // changed cases only

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rel = (e, link, prop) => ((e.related_properties || {})[link] || {})[prop];
const val = v => (v === undefined || v === null) ? '' : v;
const inIds = ids => `Id in (${ids.map(i => `'${i}'`).join(',')})`;

// Any error we did not plan for: exit so Docker restarts the container
process.on('unhandledRejection', err => { logger.error(`Unhandled promise rejection, exiting: ${err && err.stack ? err.stack : err}`); process.exit(1); });
process.on('uncaughtException', err => { logger.error(`Uncaught exception, exiting: ${err && err.stack ? err.stack : err}`); process.exit(1); });

let page = null;

// Same sign-in steps as the report exporter (OpenText SAML)
async function login() {
    logger.info('Logging in to OTSM...');
    await page.goto(config.URL, { waitUntil: 'networkidle2', timeout: 120000 });
    for (let i = 0; i < 30; i++) {
        try {
            if (page.url().includes('/reports/report/')) { logger.info('Logged in.'); return; }
            if (await page.$('#Ecom_User_ID') && await page.$('#loginButton2')) {
                await page.type('#Ecom_User_ID', config.USER_LOGIN); await page.click('#loginButton2'); await sleep(4000); continue;
            }
            if (await page.$('input[name="Ecom_Password"]') || await page.$('#password')) {
                if (await page.$('#username')) { await page.$eval('#username', el => el.value = ''); await page.type('#username', config.USER_LOGIN); }
                const passSelector = (await page.$('#password')) ? '#password' : 'input[name="Ecom_Password"]';
                await page.type(passSelector, config.PASS);
                const submit = await page.$('input[type="submit"]') || await page.$('#loginButton2');
                await submit.click(); await sleep(6000); continue;
            }
        } catch (e) { /* the page navigated under us during login: check again */ }
        await sleep(2500);
    }
    throw new Error(`Login did not reach the report page (at ${page.url()})`);
}

// GET from inside the logged-in page so the request carries the OTSM session.
// Logs in again once on 401.
async function apiGet(url, retried) {
    const r = await page.evaluate(async u => {
        const res = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } });
        return { status: res.status, text: await res.text() };
    }, url);
    if (r.status === 401 && !retried) { logger.warn('OTSM session expired (401); logging in again.'); await login(); return apiGet(url, true); }
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url.split('?')[0]}: ${r.text.slice(0, 200)}`);
    const json = JSON.parse(r.text);
    if (!json.meta || json.meta.completion_status !== 'OK') throw new Error(`Query failed (${url.split('?')[0]}): ${JSON.stringify(json.meta).slice(0, 300)}`);
    return json.entities || [];
}

// All pages of a Request query. Sorted by Id, which never changes: sorted by LastUpdateTime,
// a case updated while the pages are read moves to the end, so it is read twice and the case
// after it slips back across a page boundary and is never read.
async function requests(filter, layout) {
    const all = [];
    for (let skip = 0; ; skip += config.PAGE_SIZE) {
        const url = `${EMS('Request')}?filter=${encodeURIComponent(filter)}&layout=${encodeURIComponent(layout)}` +
            `&order=${encodeURIComponent('Id asc')}&size=${config.PAGE_SIZE}&skip=${skip}`;
        const batch = await apiGet(url);
        all.push(...batch);
        if (batch.length < config.PAGE_SIZE) return all;
    }
}

// One API Request -> one row with the QMON report's column names
function toRow(e, withDescription) {
    const p = e.properties;
    const row = {
        'Id': p.Id,
        'Title': val(p.DisplayLabel),
        'Owner.Name': val(rel(e, 'OwnedByPerson', 'Name')),
        'Updated On': val(p.LastUpdateTime),
        'Case Type': val(p.CaseType_c),
        'Creation source': val(p.CreationSource),
        'Requested by.Name': val(rel(e, 'RequestedByPerson', 'Name')),
        'Created On': val(p.EmsCreationTime),
        'Status': val(p.Status),
        'Product.Display label': val(rel(e, 'ProductInstance', 'DisplayLabel')),
        'Priority': val(p.Priority),
        'Requested for.Name': val(rel(e, 'RequestedForPerson', 'Name')),
        'Requested for.Email': val(rel(e, 'RequestedForPerson', 'Email')),
        'Requested for.Office phone number': val(rel(e, 'RequestedForPerson', 'OfficePhoneNumber')),
        'Requested for.Mobile phone number': val(rel(e, 'RequestedForPerson', 'MobilePhoneNumber')),
        'Requested for.Time zone': val(rel(e, 'RequestedForPerson', 'TimeZone')),
        'Requested for company.Display Name': val(rel(e, 'RequestToCompany', 'DisplayLabel')),
        'Requested for company.Time zone': val(rel(e, 'RequestToCompany', 'TimeZone')),
        'Requested for company.Headquarters (Region)': val(rel(e, 'RequestToCompany', 'RoutingRegion_c')),
        'FTS Host Account': val(p.FTSHostAccount_c),
        'FTS Host Password': val(p.FTSHostPassword_c),
        'Closed DateTime': val(p.ClosedDateTime_c),
        'Last Updated By.Name': val(rel(e, 'LastUpdatedBy_c', 'Name')),
        'SLT.Next target time': val(rel(e, 'SLT', 'TargetDate')),
        'Phase Id': val(p.PhaseId),
        'Assignment group.Name': val(rel(e, 'AssignedToGroup', 'Name')),
        'Customer Time Zone': val(p.CompanyTimeZoneUser_c),
        'Country of Service.Display label': val(rel(e, 'FlexCreditCountry_c', 'DisplayLabel')),
        'Product Dev ID': val(p.ProductDevID_c),
        'Product Model.Display label': val(rel(e, 'ProductModel_c', 'DisplayLabel')),
        'Closure Code.Display label': val(rel(e, 'ClosureCode_c', 'DisplayLabel')),
        'Resolved DateTime': val(p.ResolvedDateTime_c),
        'Close time': val(p.CloseTime),
        'Report location.Display label': val(rel(e, 'RegisteredForLocation', 'DisplayLabel')),
        'Report location.Display Name': val(rel(e, 'RegisteredForLocation', 'DisplayName')),
    };
    if (withDescription) {
        row['Description'] = val(p.Description);
        // Text of the newest comment of any kind (public, internal, customer, system),
        // as OTSM keeps it in LatestComment_c: plain text without line breaks
        row['Latest Comment'] = val(p.LatestComment_c);
    }
    return row;
}

// Writes rows as batches of BATCH_ROWS (at least one, possibly empty, so the parser
// always sees a new file each minute). Atomic: written in state/, then renamed.
let batchSeq = 0;
function writeBatches(rows) {
    const chunks = [];
    for (let i = 0; i < rows.length; i += config.BATCH_ROWS) chunks.push(rows.slice(i, i + config.BATCH_ROWS));
    if (chunks.length === 0) chunks.push([]);
    for (const chunk of chunks) {
        // Names sort oldest first, the order the parser reads them in
        const name = `cases_${new Date().toISOString().replace(/[:.]/g, '-')}_${String(batchSeq++).padStart(6, '0')}.json`;
        const tmp = path.join(STATE_DIR, name + '.tmp');
        fs.writeFileSync(tmp, JSON.stringify(chunk));
        if (config.ARCHIVE_PATH) fs.copyFileSync(tmp, path.join(config.ARCHIVE_PATH, name));
        fs.renameSync(tmp, path.join(config.OUTPUT_PATH, name));
    }
    return chunks.length;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE)); } catch (e) { return null; } }
function saveState(s) { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); }

async function backfill() {
    const since = Date.now() - config.BACKFILL_DAYS * 86400 * 1000;
    logger.info(`Back-fill: all open cases and closed cases updated in the last ${config.BACKFILL_DAYS} days...`);
    const layout = DETAIL_LAYOUT;
    const ents = (await requests(`Status != 'RequestStatusClosed_c'`, layout))
        // Closed cases updated in the window: closing updates a case, and some closed cases
        // have no CloseTime (only Closed/Resolved DateTime, or none), so CloseTime alone misses them
        .concat(await requests(`Status = 'RequestStatusClosed_c' and LastUpdateTime > ${since}`, layout));
    const files = writeBatches(ents.map(e => toRow(e, true)));
    logger.info(`Back-fill: ${ents.length} cases in ${files} files.`);
    return ents.reduce((m, e) => Math.max(m, e.properties.LastUpdateTime || 0), 0);
}

async function cycle(state) {
    const t0 = Date.now();
    const changed = await requests(`LastUpdateTime > ${Math.max(0, state.lastUpdate - config.OVERLAP_MS)}`, DETAIL_LAYOUT);
    const unowned = await requests(`Status != 'RequestStatusClosed_c' and OwnedByPerson = null`, LAYOUT);
    const byId = new Map();
    for (const e of unowned) byId.set(e.properties.Id, { e, desc: false });
    for (const e of changed) byId.set(e.properties.Id, { e, desc: true });     // full rows with Description win
    const all = [...byId.values()];
    // If the parser isn't reading (stopped or behind), write only the changed cases: they
    // carry changes and descriptions that must not be lost, while the unowned cases are
    // repeated every minute anyway. Keeps the backlog small until the parser catches up.
    const backlog = fs.readdirSync(config.OUTPUT_PATH).filter(f => f.endsWith('.json')).length;
    if (backlog > config.BACKLOG_LIMIT) logger.warn(`${backlog} batches not yet read by the parser; writing only the ${changed.length} changed cases.`);
    const rows = backlog > config.BACKLOG_LIMIT ? all.filter(x => x.desc) : all;
    const files = writeBatches(rows.map(x => toRow(x.e, x.desc)));
    const newest = all.reduce((m, x) => Math.max(m, x.e.properties.LastUpdateTime || 0), state.lastUpdate);
    logger.info(`Batch: ${all.length} cases (${changed.length} changed with description, ${unowned.length} unowned), ${files} file(s), ${Date.now() - t0} ms.`);
    return newest;
}

(async () => {
    logger.info(`Starting smapiexporter (output ${config.OUTPUT_PATH}).`);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (config.ARCHIVE_PATH) fs.mkdirSync(config.ARCHIVE_PATH, { recursive: true });
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    browser.on('disconnected', () => { logger.error('Browser disconnected, exiting.'); process.exit(1); });
    page = await browser.newPage();
    await login();

    let state = loadState();
    if (!state) { state = { lastUpdate: await backfill() }; saveState(state); }
    let failed = 0;
    while (true) {
        try {
            state.lastUpdate = await cycle(state);
            saveState(state);
            failed = 0;
        } catch (err) {
            failed++;
            logger.error(`Cycle failed (${failed} of ${config.MAX_FAILED_CYCLES} in a row): ${err.message}`);
            if (failed >= config.MAX_FAILED_CYCLES) { logger.error('Too many failed cycles; exiting so Docker restarts with a fresh login.'); process.exit(1); }
        }
        await sleep(config.INTERVAL);
    }
})().catch(err => { logger.error(`API exporter failed, exiting: ${err && err.stack ? err.stack : err}`); process.exit(1); });
