/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADAPTER_URL?: string;
  readonly VITE_SCP_API_TOKEN?: string;
  readonly VITE_SCP_USER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
