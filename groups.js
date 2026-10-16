/* Assignment groups and their members, for the server-side board's team setup.
At startup and every GROUP_REFRESH_HOURS: every PersonGroup (Id, Name, region, time zone)
and its members (Person?filter=PersonToGroup[Id = '<group>'], one query per group).
Written as one groups_<time>.json batch: [{ id, name, region, timeZone, members: [names] }];
the parser replaces smwb.groups with it.
*/
const REGION_NAMES = { '12975': 'EMEA', '12976': 'NA', '12977': 'APAC' };   // Region_c location Ids

function createGroups({ config, logger, apiGet, EMS, writeFile }) {
    let last = 0;

    async function refresh() {
        const t0 = Date.now();
        const groups = await apiGet(`${EMS('PersonGroup')}?layout=Id,Name,Region_c,TimeZone&size=1000`);
        const out = [];
        for (const g of groups) {
            const p = g.properties;
            const members = await apiGet(`${EMS('Person')}?filter=${encodeURIComponent(`PersonToGroup[Id = '${p.Id}']`)}&layout=Id,Name&size=1000`);
            out.push({ id: String(p.Id), name: p.Name || '', region: REGION_NAMES[String(p.Region_c || '')] || '', timeZone: p.TimeZone || '',
                members: members.map(m => m.properties.Name || '').filter(Boolean) });
        }
        writeFile('groups', out);
        last = Date.now();
        logger.info(`Groups: ${out.length} assignment groups, ${out.reduce((s, g) => s + g.members.length, 0)} memberships, ${Date.now() - t0} ms.`);
    }

    // Called each minute; does the work only when due. A failure is retried next minute.
    async function cycle() {
        if (Date.now() - last < config.GROUP_REFRESH_HOURS * 3600e3) return;
        try { await refresh(); } catch (err) { logger.error(`Groups refresh failed: ${err.message}`); }
    }

    return { cycle };
}

module.exports = { createGroups };
