// Vertex AI Gemini adapter for planWithLLM — the production LLM wiring.
//
// Deliberately NOT a managed data-agent chat endpoint: those return
// server-generated Vega-Lite chart payloads — the architecture this project
// replaces. Lookbook needs exactly one generateContent call per turn that
// returns {answer, patches} JSON; plain Vertex Gemini does that directly.
//
// Security note: in the shipped Looker product this request MUST go through
// the React host (which holds auth), not from the sandboxed iframe — same
// postMessage pattern as LOOKBOOK_QUERY. The direct-fetch form below is for
// local development with a short-lived `gcloud auth print-access-token`.
//
// Enable in the demo app via the browser console:
//   localStorage.setItem("lookbook.gemini", JSON.stringify({
//     projectId: "my-project", accessToken: "ya29...",  // gcloud auth print-access-token
//     location: "us-central1", model: "gemini-2.5-flash",
//   }));
// then reload. Remove the key to return to the deterministic rules planner.

export function vertexGeminiCaller({ projectId, accessToken, location = "us-central1", model = "gemini-2.5-flash" }) {
  if (!projectId || !accessToken) throw new Error("vertexGeminiCaller requires projectId and accessToken");
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  return async ({ system, user }) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`Vertex AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  };
}

// Reads the localStorage config; returns a callModel function or null.
export function configuredGeminiCaller() {
  try {
    const cfg = JSON.parse(localStorage.getItem("lookbook.gemini") || "null");
    return cfg ? vertexGeminiCaller(cfg) : null;
  } catch {
    return null;
  }
}
