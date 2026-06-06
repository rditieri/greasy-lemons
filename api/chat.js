// File IDs for uploaded manual documents (set via env vars after running scripts/upload-manual.js)
const MANUAL_FILE_IDS = [
  process.env.ANTHROPIC_FILE_ID_SPECS,       // 2zz_ge_specs.md — service specs, torque, clearances
  process.env.ANTHROPIC_FILE_ID_MAINTENANCE, // celica_maintenance.md — maintenance intervals, fluids
].filter(Boolean);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = { ...req.body };

    // Inject manual document blocks into the first user message so Claude has
    // the full shop manual data in context. cache_control means Anthropic caches
    // the file tokens server-side after the first request — subsequent calls are ~10x cheaper.
    if (MANUAL_FILE_IDS.length > 0 && Array.isArray(body.messages)) {
      const firstUserIdx = body.messages.findIndex((m) => m.role === "user");
      if (firstUserIdx !== -1) {
        const firstMsg = body.messages[firstUserIdx];

        // Normalise content to an array
        const existingContent =
          typeof firstMsg.content === "string"
            ? [{ type: "text", text: firstMsg.content }]
            : [...firstMsg.content];

        // Skip injection if doc blocks are already present (e.g. repeated requests)
        const alreadyInjected = existingContent.some((b) => b.type === "document");

        if (!alreadyInjected) {
          const docBlocks = MANUAL_FILE_IDS.map((file_id) => ({
            type: "document",
            source: { type: "file", file_id },
            cache_control: { type: "ephemeral" },
          }));

          body.messages[firstUserIdx] = {
            ...firstMsg,
            content: [...docBlocks, ...existingContent],
          };
        }
      }
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
