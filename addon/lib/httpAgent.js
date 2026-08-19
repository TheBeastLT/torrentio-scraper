import { setGlobalDispatcher, Agent } from 'undici';
// Force HTTP/1.1 for all global fetch. undici's HTTP/2 abort path is broken on Node 26
setGlobalDispatcher(new Agent({ allowH2: false }));
