// The small query surface the store reads through (collection(name).orderBy(field, dir).limit(n).onSnapshot(cb)), shared by the
// replica and the desktop-database client so both answer it identically. `docs()` returns [{ id, data() }] for the current contents.
export function queryCollection(listeners, docs) {
  const q = { field: null, dir: "asc", n: Infinity };
  const api = {
    orderBy(field, dir = "asc") { q.field = field; q.dir = dir; return api; },
    limit(n) { q.n = n; return api; },
    onSnapshot(cb) {
      const fire = () => {
        const d = docs();
        if (q.field) d.sort((a, b) => { const x = a.data()[q.field], y = b.data()[q.field]; return (x < y ? -1 : x > y ? 1 : 0) * (q.dir === "desc" ? -1 : 1); });
        cb({ docs: d.slice(0, q.n) });
      };
      listeners.add(fire); fire();
      return () => listeners.delete(fire);
    },
  };
  return api;
}
