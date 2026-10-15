/* Case comments for smapiexporter.
OTSM keeps comments in its collaboration service, not on the case:
GET /rest/<tenant>/collaboration/comments/Request/<case> returns every comment of one case
(no filter or paging; ~13 comments, ~22 KB and ~110 ms per case). Each minute this fetches
the comment lists of the cases that changed (a new comment always updates the case), plus
COMMENT_FILL_PER_CYCLE cases from a queue that fills in the history of older cases in the
background (open cases first, then closed ones updated in the last BACKFILL_DAYS). The
first-start case load doesn't wait for comments.
Writes comments_<time>_<seq>.json batches: [{ caseId, comments: [...] }] with each case's
full list, so the parser can also drop comments that were deleted. Submitter Ids are turned
into names with one Person query per batch of new Ids (cached).
*/
const fs = require('fs');
const path = require('path');

function createComments({ config, logger, getJson, requests, EMS, collabUrl, stateDir, writeFile }) {
    const STATE = path.join(stateDir, 'comments-state.json');
    const people = new Map();      // Person Id -> Name, kept for the life of the container
    let state = null;

    function load() { try { return JSON.parse(fs.readFileSync(STATE)); } catch (e) { return null; } }
    function save() { fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE + '.tmp', STATE); }

    // Queue for the background fill: open cases first, then closed ones updated recently
    async function buildQueue() {
        const since = Date.now() - config.BACKFILL_DAYS * 86400 * 1000;
        const open = await requests(`Status != 'RequestStatusClosed_c'`, 'Id');
        const closed = await requests(`Status = 'RequestStatusClosed_c' and LastUpdateTime > ${since}`, 'Id');
        state = { pending: [...new Set(open.concat(closed).map(e => String(e.properties.Id)))], built: Date.now() };
        save();
        logger.info(`Comments: history fill queued for ${state.pending.length} cases (${open.length} open first).`);
    }

    async function resolvePeople(ids) {
        const missing = [...new Set(ids.filter(id => id && !people.has(String(id))))];
        for (let i = 0; i < missing.length; i += 100) {
            const chunk = missing.slice(i, i + 100);
            const json = await getJson(`${EMS('Person')}?filter=${encodeURIComponent(`Id in (${chunk.map(id => `'${id}'`).join(',')})`)}&layout=Id,Name&size=100`);
            for (const e of (json.entities || [])) people.set(String(e.properties.Id), e.properties.Name || '');
            for (const id of chunk) if (!people.has(String(id))) people.set(String(id), '');
        }
    }

    async function fetchCase(caseId) {
        const list = await getJson(collabUrl(caseId));
        if (!Array.isArray(list)) throw new Error(`comments for ${caseId}: not a list`);
        return list;
    }

    function toComment(c) {
        const v = x => (x === undefined || x === null) ? '' : x;
        const submitter = c.Submitter && c.Submitter.UserId ? String(c.Submitter.UserId) : '';
        return {
            Id: v(c.Id), CreateTime: v(c.CreateTime), UpdateTime: v(c.UpdateTime),
            SubmitterId: submitter, SubmitterName: submitter ? (people.get(submitter) || '') : '',
            CommentFrom: v(c.CommentFrom), CommentTo: v(c.CommentTo), PrivacyType: v(c.PrivacyType),
            FunctionalPurpose: v(c.FunctionalPurpose), IsSystem: !!c.IsSystem, Media: v(c.Media),
            ActualInterface: v(c.ActualInterface), Body: v(c.Body),
        };
    }

    // One minute's work: comments of the changed cases, plus part of the history fill
    // (skipped while the parser is behind). A case whose fetch fails goes back on the queue.
    async function cycle(changedIds, parserBehind) {
        const t0 = Date.now();
        if (!state) state = load();
        if (!state) await buildQueue();
        const changed = [...new Set(changedIds.map(String))];
        const changedSet = new Set(changed);
        state.pending = state.pending.filter(id => !changedSet.has(id));
        const fill = parserBehind ? [] : state.pending.splice(0, config.COMMENT_FILL_PER_CYCLE);
        const results = [], failed = [];
        for (const id of changed.concat(fill)) {
            try { results.push({ caseId: id, raw: await fetchCase(id) }); }
            catch (err) { failed.push(id); logger.warn(`Comments for case ${id} failed (${err.message}); will retry.`); }
        }
        state.pending = failed.concat(state.pending);
        await resolvePeople([].concat(...results.map(r => r.raw.map(c => c.Submitter && c.Submitter.UserId))));
        const out = results.map(r => ({ caseId: r.caseId, comments: r.raw.map(toComment) }));
        const files = out.length ? writeFile('comments', out) : 0;
        save();
        const n = out.reduce((s, r) => s + r.comments.length, 0);
        if (out.length) logger.info(`Comments: ${out.length} cases (${changed.length} changed, ${fill.length} history fill), ${n} comments, ` +
            `${files} file(s), ${Date.now() - t0} ms; ${state.pending.length} cases left to fill.`);
        if (fill.length && state.pending.length === 0) logger.info('Comments: history fill complete.');
    }

    return { cycle };
}

module.exports = { createComments };
