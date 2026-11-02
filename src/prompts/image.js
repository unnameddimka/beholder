// Image-generation prompt (Specification 0005 C5): the Dialogue model's self-contained image request, followed by the
// character's three descriptions as clearly marked background. The Images API takes one prompt string, so the
// context travels inside it; empty fields are left out, and nothing is shortened to fit a provider limit.

// The descriptions frozen with a queued image (images.context), so a resumed or retried image keeps them.
export function imageContext(profile) {
  return { characterName: profile.name, characterDescription: profile.description, sceneDescription: profile.sceneDescription, userDescription: profile.userDescription };
}

// context null (an image queued before Specification 0005) sends the request alone, as it was queued.
export function imagePrompt(request, context) {
  if (!context) return request;
  const fields = [
    context.characterDescription.trim() ? `The character showing this image (${context.characterName}): ${context.characterDescription.trim()}` : null,
    context.sceneDescription.trim() ? `The scene of the conversation: ${context.sceneDescription.trim()}` : null,
    context.userDescription.trim() ? `The viewer, as they describe themselves: ${context.userDescription.trim()}` : null
  ].filter(Boolean);
  if (!fields.length) return request;
  return [
    "IMAGE REQUEST (what to depict):",
    request,
    "",
    "BACKGROUND CONTEXT (from the chat this image belongs to; use it only to inform style, mood, setting or likeness where the image request calls for it; do not add these people, places or objects unless the request asks for them; this is not part of the request):",
    ...fields
  ].join("\n");
}
