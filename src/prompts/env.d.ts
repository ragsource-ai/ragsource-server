// Typendeklaration für Wrangler-Text-Imports (*.md als string)
declare module "*.md" {
  const content: string;
  export default content;
}
