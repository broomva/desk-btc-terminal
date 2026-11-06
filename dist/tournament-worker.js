import { runTournament } from "./tournament.js";

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ id: data.id, result: runTournament(data.options) });
  } catch (error) {
    self.postMessage({
      id: data?.id,
      error: error.message || "Forecast evaluation failed",
    });
  }
};
