// Keep assertion failures readable without dumping whole plugin sources.
export default async function* (events) {
  for await (const event of events) {
    const d = event.data;
    if (event.type === "test:fail") {
      const cause = d.details?.error?.cause || d.details?.error;
      yield `FAIL ${d.name}\n${String(cause?.message || "").slice(0, 700)}\n${String(cause?.stack || "").split("\n").filter(line => /at .*test\.js/.test(line)).slice(0, 2).join("\n")}\n`;
    }
    if (event.type === "test:summary") yield JSON.stringify({ success: d.success, counts: d.counts }) + "\n";
  }
}
