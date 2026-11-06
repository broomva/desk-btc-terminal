import { runPaperExperiment } from "./paper-engine.js";
self.onmessage = ({ data }) => {
  try {
    self.postMessage({
      result: runPaperExperiment(data.recording, data.config),
    });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
