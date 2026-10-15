// Isolate-local, database-scoped metadata only; never cache credential tokens or authorization decisions.
const scopes = new WeakMap();
export function dbCache(db) {
  let value=scopes.get(db); if(!value){value={};scopes.set(db,value);} return value;
}
