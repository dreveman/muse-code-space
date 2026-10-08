declare module "*.css";
declare module "*.webp" {
  const url: string;
  export default url;
}
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.md" {
  const text: string;
  export default text;
}
