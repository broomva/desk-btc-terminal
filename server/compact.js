// Compact replay preserves representative actual events, never synthetic
// volume aggregates. Raw acquisition remains available as its own download.
export function compactReplayStream(file) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = { book: null, trade: null };
  const intervals = { book: 30000, trade: 10000 };
  let tail = "";
  let bytes = 0;
  const emit = (event, controller) => {
    const output = encoder.encode(`${JSON.stringify(event)}\n`);
    bytes += output.length;
    if (bytes > 48 * 1024 * 1024)
      throw new Error("Compact replay exceeds 48MiB; use a shorter recording");
    controller.enqueue(output);
  };
  function line(text, controller) {
    if (!text.trim()) return;
    const event = JSON.parse(text);
    if (event.type === "book" || event.type === "trade") {
      if (!Number.isFinite(event.timestamp))
        throw new Error("Recorded event has no timestamp");
      const bucket = Math.floor(event.timestamp / intervals[event.type]);
      const previous = pending[event.type];
      if (previous && previous.bucket !== bucket)
        emit(previous.event, controller);
      pending[event.type] = { bucket, event };
    } else {
      if (event.type === "session")
        event.replaySampling = {
          bookSampleMs: 30000,
          tradeSampleMs: 10000,
          observations: "all normalized live MID/top25 observations, unchanged",
          selection:
            "last actual event in each time bucket; not volume aggregates",
          ordering: "sort event timestamps before replay",
          rawDownload:
            "unmodified recording retains all acquired trade updates",
        };
      emit(event, controller);
    }
  }
  return file.stream(65536).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        tail += decoder.decode(chunk, { stream: true });
        const lines = tail.split("\n");
        tail = lines.pop();
        if (tail.length > 1024 * 1024)
          throw new Error("Recorded event exceeds 1MiB");
        for (const entry of lines) line(entry, controller);
      },
      flush(controller) {
        tail += decoder.decode();
        if (tail.trim()) line(tail, controller);
        for (const entry of Object.values(pending))
          if (entry) emit(entry.event, controller);
      },
    }),
  );
}
