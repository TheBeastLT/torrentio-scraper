import { Providers, QualityFilter, SizeFilter } from './filter.js';
import { SortOptions } from './sort.js';
import { LanguageOptions } from './languages.js';
import { DebridOptions } from '../moch/options.js';
import { MochOptions } from '../moch/moch.js';

export default function landingTemplate(manifest, config = {}) {
  const savedProviders = config[Providers.key] || Providers.options.map(p => p.key);
  const savedSort = config[SortOptions.key] || SortOptions.options.qualitySeeders.key;
  const savedLanguages = config[LanguageOptions.key] || [];
  const savedQuality = config[QualityFilter.key] || [];
  const savedSize = (config[SizeFilter.key] || []).join(',');
  const savedLimit = config.limit || '';
  const savedDebridOpts = config[DebridOptions.key] || [];

  const savedDebridProvider = Object.keys(MochOptions).find(key => config[key]) || 'none';

  const apiKeys = {
    [MochOptions.realdebrid.key]: config[MochOptions.realdebrid.key] || '',
    [MochOptions.premiumize.key]: config[MochOptions.premiumize.key] || '',
    [MochOptions.alldebrid.key]: config[MochOptions.alldebrid.key] || '',
    [MochOptions.debridlink.key]: config[MochOptions.debridlink.key] || '',
    [MochOptions.easydebrid.key]: config[MochOptions.easydebrid.key] || '',
    [MochOptions.offcloud.key]: config[MochOptions.offcloud.key] || '',
    [MochOptions.torbox.key]: config[MochOptions.torbox.key] || '',
    [MochOptions.putio.key]: config[MochOptions.putio.key] || '',
  };

  let putioClientId = '';
  let putioToken = '';
  if(apiKeys[MochOptions.putio.key] && apiKeys[MochOptions.putio.key].includes('@')){
    const parts = apiKeys[MochOptions.putio.key].split('@');
    putioClientId = parts[0];
    putioToken = parts[1];
  }

  const background = manifest.background || 'https://dl.strem.io/addon-background.jpg';
  const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png';

  const providerList = Providers.options.map(p => ({ label: (p.foreign ? p.foreign + ' ' : '') + p.label, value: p.key }));
  const sortList = Object.values(SortOptions.options).map(o => ({ label: o.description, value: o.key }));
  const languageList = LanguageOptions.options.map(o => ({ label: o.label, value: o.key }));
  const qualityList = Object.values(QualityFilter.options).map(o => ({ label: o.label, value: o.key }));
  const debridProviderList = Object.values(MochOptions).map(o => ({ label: o.name, value: o.key }));
  const debridOptList = Object.values(DebridOptions.options).map(o => ({ label: o.description, value: o.key }));

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>${manifest.name} - Configuration</title>
      <link rel="shortcut icon" href="${logo}" type="image/x-icon">
      <script src="https://cdn.tailwindcss.com"></script>
      <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
      
      <style>
          body { font-family: 'Inter', sans-serif; }
          .glass {
              background: rgba(17, 24, 39, 0.90);
              backdrop-filter: blur(16px);
              -webkit-backdrop-filter: blur(16px);
              border: 1px solid rgba(255, 255, 255, 0.1);
          }
          .scroller::-webkit-scrollbar { width: 6px; }
          .scroller::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); }
          .scroller::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
          [x-cloak] { display: none !important; }
          
          .line-clamp-2 {
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          @media (min-width: 768px) {
            .md\\:line-clamp-none {
                -webkit-line-clamp: unset;
            }
          }
      </style>

      <script>
          document.addEventListener('alpine:init', () => {
              Alpine.data('addonConfig', () => ({
                  providers: ${JSON.stringify(savedProviders)},
                  sort: ${JSON.stringify(savedSort)},
                  languages: ${JSON.stringify(savedLanguages)},
                  qualities: ${JSON.stringify(savedQuality)},
                  limit: ${JSON.stringify(savedLimit)},
                  sizeFilter: ${JSON.stringify(savedSize)},
                  debridProvider: ${JSON.stringify(savedDebridProvider)},
                  debridOpts: ${JSON.stringify(savedDebridOpts)},
                  apiKeys: ${JSON.stringify(apiKeys)},
                  putioClientId: ${JSON.stringify(putioClientId)},
                  putioToken: ${JSON.stringify(putioToken)},
                  installUrl: '#',
                  
                  // UI Status
                  copiedDonation: '',
                  copiedInstall: false,
                  descExpanded: false,
                  showSizeInfo: false,

                  // Simple transition object
                  tooltipTransition: {
                      ['x-transition:enter']: 'transition ease-out duration-200',
                      ['x-transition:enter-start']: 'opacity-0 translate-y-1',
                      ['x-transition:enter-end']: 'opacity-100 translate-y-0',
                      ['x-transition:leave']: 'transition ease-in duration-150',
                      ['x-transition:leave-start']: 'opacity-100 translate-y-0',
                      ['x-transition:leave-end']: 'opacity-0 translate-y-1',
                  },

                  options: {
                      providers: ${JSON.stringify(providerList)},
                      sort: ${JSON.stringify(sortList)},
                      languages: ${JSON.stringify(languageList)},
                      qualities: ${JSON.stringify(qualityList)},
                      debridProviders: ${JSON.stringify(debridProviderList)},
                      debridOpts: ${JSON.stringify(debridOptList)},
                  },
                  
                  donationAddresses: {
                      BTC: 'bc1qkfrm3zukkrehg2twpzv2zurzfhjmk4lce92paf',
                      ETH: '0xc451992e770cf1528b50405d56b17a1f257435fe',
                      SOL: '55qSqbxNT7UnZZ4zDYNDStHphiTXkH4gkbPc4RRLQmmy'
                  },

                  toggleProvider(value) {
                      if (this.providers.includes(value)) {
                          this.providers = this.providers.filter(x => x !== value);
                      } else {
                          this.providers.push(value);
                      }
                  },

                  generateLink() {
                      const allProvidersCount = this.options.providers.length;
                      const providerStr = (this.providers.length > 0 && this.providers.length < allProvidersCount) 
                          ? this.providers.join(',') 
                          : '';

                      const qualityStr = this.qualities.join(',');
                      const sortStr = (this.sort !== '${SortOptions.options.qualitySeeders.key}') ? this.sort : '';
                      const langStr = this.languages.join(',');
                      const limitStr = (/^[1-9][0-9]{0,2}$/.test(this.limit)) ? this.limit : '';
                      const sizeStr = this.sizeFilter;
                      const debridOptStr = this.debridOpts.join(',');
                      
                      const activeDebrid = this.debridProvider;
                      let activeKey = '';
                      
                      if (activeDebrid === '${MochOptions.putio.key}') {
                          if (this.putioClientId && this.putioToken) {
                              activeKey = this.putioClientId.trim() + '@' + this.putioToken.trim();
                          }
                      } else if (activeDebrid !== 'none') {
                          activeKey = this.apiKeys[activeDebrid] ? this.apiKeys[activeDebrid].trim() : '';
                      }

                      const configMap = [
                          ['${Providers.key}', providerStr],
                          ['${SortOptions.key}', sortStr],
                          ['${LanguageOptions.key}', langStr],
                          ['${QualityFilter.key}', qualityStr],
                          ['limit', limitStr],
                          ['${SizeFilter.key}', sizeStr],
                          ['${DebridOptions.key}', debridOptStr],
                          [activeDebrid, activeKey]
                      ];

                      const configPath = configMap
                          .filter(([k, v]) => v && v.length > 0 && k !== 'none')
                          .map(([k, v]) => k + '=' + v)
                          .join('|');

                      this.installUrl = 'stremio://' + window.location.host + (configPath ? '/' + configPath : '') + '/manifest.json';
                  },
                  
                  copyLink() {
                      const httpsLink = this.installUrl.replace('stremio://', 'https://');
                      navigator.clipboard.writeText(httpsLink).then(() => {
                          this.copiedInstall = true;
                          setTimeout(() => { this.copiedInstall = false }, 2000);
                      });
                  },
                  
                  copyDonation(type) {
                      const addr = this.donationAddresses[type];
                      navigator.clipboard.writeText(addr).then(() => {
                          this.copiedDonation = type;
                          setTimeout(() => { this.copiedDonation = '' }, 2000);
                      });
                  }
              }))
          });
      </script>
  </head>
  <body class="bg-gray-900 text-gray-100 min-h-screen flex items-center justify-center md:px-4 md:py-10 relative overflow-y-auto"
        style="background-image: url('${background}'); background-size: cover; background-position: center; background-attachment: fixed;">
      
      <div class="absolute inset-0 bg-black bg-opacity-70 z-0"></div>

      <div x-data="addonConfig" x-effect="generateLink()" x-cloak class="relative z-10 w-full md:max-w-5xl glass rounded-none md:rounded-2xl shadow-2xl flex flex-col h-full md:h-auto">
          
          <div class="text-center py-3 px-4 flex-shrink-0 bg-gray-900/40 border-b border-gray-700/50 md:rounded-t-2xl">
              <img src="${logo}" class="w-12 h-12 md:w-20 md:h-20 mx-auto rounded-xl shadow-lg mb-2" alt="Logo">
              
              <div class="flex flex-wrap items-center justify-center gap-2 md:gap-3 mb-1">
                  <h1 class="text-lg md:text-2xl font-bold tracking-tight text-white">${manifest.name}</h1>
                  <span class="text-[10px] md:text-xs font-mono bg-gray-800 text-indigo-400 border border-gray-700 px-1.5 py-0.5 rounded shadow-sm select-none">
                      v${manifest.version || '0.0.0'}
                  </span>
              </div>

              <div 
                  @click="descExpanded = !descExpanded" 
                  @keydown.enter="descExpanded = !descExpanded"
                  @keydown.space.prevent="descExpanded = !descExpanded"
                  tabindex="0"
                  role="button"
                  :aria-expanded="descExpanded"
                  aria-label="Expand or collapse description"
                  class="group cursor-pointer max-w-4xl mx-auto focus:outline-none focus:ring-2 focus:ring-indigo-500/50 rounded p-1"
              >
                  <p class="text-xs md:text-sm text-gray-400 leading-relaxed transition-all duration-200"
                     :class="descExpanded ? '' : 'line-clamp-2 md:line-clamp-none'">
                      ${manifest.description || 'Configuration'}
                  </p>
                  <div class="md:hidden text-[10px] text-indigo-400 mt-1 opacity-80" x-text="descExpanded ? 'Show less' : 'Show more'"></div>
              </div>
          </div>

          <div class="p-4 md:p-6 space-y-6 md:space-y-8 overflow-y-auto md:overflow-visible scroller md:no-scrollbar flex-grow md:flex-grow-0">
              
              <div>
                  <div class="flex justify-between items-center mb-2 md:mb-3">
                    <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider">Providers</h3>
                    <button 
                        @click="providers = options.providers.map(p => p.value)" 
                        class="text-xs text-indigo-400 hover:text-indigo-300 focus:outline-none focus:text-indigo-200 focus:underline"
                    >Select All</button>
                  </div>
                  <div class="flex flex-wrap gap-2">
                      <template x-for="p in options.providers" :key="p.value">
                          <button 
                              @click="toggleProvider(p.value)"
                              :class="providers.includes(p.value) ? 'bg-indigo-600 text-white border-indigo-500 shadow-lg shadow-indigo-500/20' : 'bg-gray-800 text-gray-400 border-gray-700 hover:bg-gray-700'"
                              class="px-2.5 py-1.5 md:px-3 md:py-1.5 rounded-full text-[10px] md:text-xs font-semibold border transition-all duration-200 select-none focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-indigo-500">
                              <span x-text="p.label"></span>
                          </button>
                      </template>
                  </div>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8">
                  <div>
                      <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Sorting</label>
                      <select x-model="sort" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                          <template x-for="opt in options.sort">
                              <option :value="opt.value" x-text="opt.label" :selected="opt.value === sort"></option>
                          </template>
                      </select>
                  </div>
                  <div>
                      <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2" x-text="['${SortOptions.options.seeders.key}', '${SortOptions.options.size.key}'].includes(sort) ? 'Max Results' : 'Max Results per Quality'"></label>
                      <input x-model="limit" type="number" placeholder="All results" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                  </div>
              </div>

              <div>
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Priority Language</label>
                  <div class="bg-gray-800 rounded-lg border border-gray-700 max-h-32 md:max-h-48 overflow-y-auto scroller">
                      <template x-for="lang in options.languages" :key="lang.value">
                          <label class="flex items-center px-4 py-2 hover:bg-gray-700 cursor-pointer border-b border-gray-700/50 last:border-0 transition-colors focus-within:bg-gray-700">
                              <input type="checkbox" :value="lang.value" x-model="languages" class="w-4 h-4 text-indigo-600 rounded bg-gray-900 border-gray-600 focus:ring-indigo-500 focus:ring-offset-gray-800">
                              <span class="ml-3 text-xs md:text-sm text-gray-200" x-text="lang.label"></span>
                          </label>
                      </template>
                  </div>
              </div>

              <div>
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Exclude Resolutions</label>
                  <div class="flex flex-wrap gap-2">
                      <template x-for="q in options.qualities" :key="q.value">
                          <label class="flex items-center space-x-2 cursor-pointer bg-gray-800 px-3 py-2 rounded-lg border border-gray-700 hover:border-gray-500 transition-colors select-none focus-within:ring-2 focus-within:ring-red-500/50 focus-within:border-red-500">
                              <input type="checkbox" :value="q.value" x-model="qualities" class="w-4 h-4 text-red-500 rounded bg-gray-900 border-gray-600 focus:ring-red-500 focus:ring-offset-gray-800">
                              <span class="text-[10px] md:text-xs font-medium text-gray-300" x-text="q.label"></span>
                          </label>
                      </template>
                  </div>
              </div>
              
               <div>
                  <div class="flex items-center gap-2 mb-2">
                      <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider">Video Size Limit</label>
                      
                      <div class="group relative flex items-center" @click.outside="showSizeInfo = false">
                          <svg 
                              @click="showSizeInfo = !showSizeInfo"
                              tabindex="0" 
                              role="button" 
                              aria-label="Info about size limit" 
                              class="h-4 w-4 text-gray-500 cursor-help hover:text-indigo-400 focus:text-indigo-400 transition-colors focus:outline-none" 
                              fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <div 
                              x-show="showSizeInfo" 
                              x-bind="tooltipTransition"
                              class="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-4 w-64 p-3 bg-black/95 backdrop-blur-sm text-xs text-gray-200 rounded-lg shadow-xl border border-gray-700 text-center leading-relaxed z-50"
                              style="display: none;"
                          >
                              Returned videos cannot exceed this size, use comma to have different size for movies and series. Examples: 5GB ; 800MB ; 10GB,2GB
                              <div class="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1 border-4 border-transparent border-t-black/95"></div>
                          </div>
                      </div>
                  </div>
                  <input x-model="sizeFilter" type="text" placeholder="e.g. 2GB, 500MB" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
              </div>

              <div class="h-px bg-gray-700 w-full"></div>

              <div class="bg-gray-800/40 rounded-xl p-4 md:p-5 border border-gray-700/50">
                  <div class="mb-4">
                      <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Debrid Provider</label>
                      <div class="relative">
                          <select x-model="debridProvider" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none appearance-none">
                              <option value="none">None</option>
                              <template x-for="p in options.debridProviders">
                                  <option :value="p.value" x-text="p.label" :selected="p.value === debridProvider"></option>
                              </template>
                          </select>
                          <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
                              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                          </div>
                      </div>
                  </div>

                  <div x-show="debridProvider !== 'none'" x-transition class="space-y-4 pt-2">
                      
                      <div x-show="debridProvider !== '${MochOptions.putio.key}'">
                          <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">API Key</label>
                          <input type="text" x-model="apiKeys[debridProvider]" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                          <div class="mt-2 text-right">
                              <a target="_blank" 
                                 :href="
                                  debridProvider === '${MochOptions.realdebrid.key}' ? 'https://real-debrid.com/apitoken' :
                                  debridProvider === '${MochOptions.alldebrid.key}' ? 'https://alldebrid.com/apikeys' :
                                  debridProvider === '${MochOptions.premiumize.key}' ? 'https://www.premiumize.me/account' :
                                  debridProvider === '${MochOptions.debridlink.key}' ? 'https://debrid-link.fr/webapp/apikey' :
                                  debridProvider === '${MochOptions.offcloud.key}' ? 'https://offcloud.com/#/account' :
                                  debridProvider === '${MochOptions.torbox.key}' ? 'https://torbox.app/settings' : '#'
                                 "
                                 class="text-[10px] md:text-xs text-indigo-400 hover:text-indigo-300 hover:underline focus:outline-none focus:ring-1 focus:ring-indigo-400 rounded">
                                  Find API Key &rarr;
                              </a>
                          </div>
                      </div>

                      <div x-show="debridProvider === '${MochOptions.putio.key}'" class="grid grid-cols-2 gap-4">
                          <div>
                              <input type="text" x-model="putioClientId" placeholder="Client ID" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                          </div>
                          <div>
                              <input type="text" x-model="putioToken" placeholder="Token" class="w-full bg-gray-800 border border-gray-700 text-xs md:text-sm text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                          </div>
                      </div>

                      <div class="pt-2">
                          <label class="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Options</label>
                          <div class="flex flex-wrap gap-2">
                              <template x-for="opt in options.debridOpts" :key="opt.value">
                                  <label class="flex items-center space-x-2 cursor-pointer bg-gray-900/50 px-3 py-1.5 rounded border border-gray-700 select-none focus-within:ring-2 focus-within:ring-indigo-500/50">
                                      <input type="checkbox" :value="opt.value" x-model="debridOpts" class="w-3.5 h-3.5 text-indigo-600 rounded bg-gray-800 border-gray-600 focus:ring-indigo-500 focus:ring-offset-gray-800">
                                      <span class="text-[10px] md:text-xs font-medium text-gray-300" x-text="opt.label"></span>
                                  </label>
                              </template>
                          </div>
                      </div>
                  </div>
              </div>

          </div>

          <div class="p-4 md:p-5 bg-gray-900/95 border-t border-gray-800 flex-shrink-0 z-20 space-y-4 md:rounded-b-2xl">
              
              <div>
                  <a :href="installUrl" class="block w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-center py-3 md:py-3.5 rounded-xl shadow-lg transition-all transform active:scale-[0.98] text-sm md:text-base focus:outline-none focus:ring-4 focus:ring-indigo-500/50">
                      INSTALL
                  </a>
                  <div class="text-center mt-3">
                      <button 
                          @click="copyLink" 
                          class="relative group text-[10px] md:text-xs text-gray-500 hover:text-gray-300 underline focus:outline-none focus:text-indigo-300"
                      >
                          Copy Link
                          <div 
                              x-show="copiedInstall" 
                              x-bind="tooltipTransition"
                              class="absolute bottom-full mb-4 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] py-1 px-3 rounded-md shadow-lg border border-gray-700 whitespace-nowrap z-50 pointer-events-none"
                              style="display: none;"
                          >
                              Copied!
                              <div class="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1 border-4 border-transparent border-t-black"></div>
                          </div>
                      </button>
                  </div>
              </div>
              
              <div class="pt-2 border-t border-gray-800/50">
                  <p class="text-center text-[10px] text-gray-500 uppercase tracking-widest font-bold mb-3">Support Development</p>
                  <div class="flex justify-center gap-4">
                      <button 
                          @click="copyDonation('BTC')" 
                          aria-label="Donate Bitcoin (BTC)"
                          class="group relative p-2 rounded-lg bg-gray-800/50 hover:bg-orange-500/10 border border-gray-700 hover:border-orange-500/50 transition-all focus:outline-none focus:ring-2 focus:ring-orange-500">
                          <svg class="w-4 h-4 md:w-5 md:h-5 text-gray-400 group-hover:text-orange-500 group-focus:text-orange-500" fill="currentColor" fill-rule="nonzero" viewBox="6 6 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" fill-rule="nonzero" d="M26.522 16.035c0.361 -2.397 -1.469 -3.688 -3.961 -4.547l0.81 -3.248 -1.977 -0.49 -0.787 3.161q-0.783 -0.192 -1.583 -0.375l0.796 -3.184 -1.981 -0.49 -0.81 3.248q-0.646 -0.147 -1.263 -0.297l0.004 -0.009 -2.726 -0.682 -0.526 2.114s1.469 0.333 1.437 0.357c0.8 0.201 0.943 0.732 0.919 1.152l-0.924 3.701q0.083 0.019 0.205 0.064l-0.211 -0.051 -1.29 5.183c-0.096 0.243 -0.348 0.608 -0.906 0.467a32.012 32.012 0 0 1 -1.437 -0.357l-0.979 2.259 2.576 0.64 1.409 0.365 -0.819 3.285 1.977 0.49 0.81 -3.248q0.81 0.22 1.574 0.407l-0.806 3.235 1.977 0.49 0.819 -3.28c3.372 0.64 5.906 0.38 6.972 -2.668 0.86 -2.452 -0.041 -3.871 -1.817 -4.795 1.29 -0.297 2.265 -1.148 2.525 -2.901m-4.518 6.338c-0.608 2.457 -4.744 1.126 -6.085 0.796l1.084 -4.351c1.34 0.333 5.637 0.998 5 3.555m0.614 -6.369c-0.558 2.233 -3.999 1.098 -5.11 0.819l0.983 -3.948c1.116 0.279 4.712 0.796 4.127 3.125"/></svg>
                          <div 
                              x-show="copiedDonation === 'BTC'" 
                              x-bind="tooltipTransition"
                              class="absolute bottom-full mb-4 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] py-1 px-3 rounded-md shadow-lg border border-gray-700 whitespace-nowrap z-50 pointer-events-none"
                              style="display: none;"
                          >
                              Copied!
                              <div class="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1 border-4 border-transparent border-t-black"></div>
                          </div>
                      </button>
                      
                      <button 
                          @click="copyDonation('ETH')"
                          aria-label="Donate Ethereum (ETH)" 
                          class="group relative p-2 rounded-lg bg-gray-800/50 hover:bg-[#627EEA]/10 border border-gray-700 hover:border-[#627EEA]/50 transition-all focus:outline-none focus:ring-2 focus:ring-[#627EEA]">
                          <svg class="w-4 h-4 md:w-5 md:h-5 text-gray-400 group-hover:text-[#627EEA] group-focus:text-[#627EEA]" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z"/></svg>
                          <div 
                              x-show="copiedDonation === 'ETH'" 
                              x-bind="tooltipTransition"
                              class="absolute bottom-full mb-4 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] py-1 px-3 rounded-md shadow-lg border border-gray-700 whitespace-nowrap z-50 pointer-events-none"
                              style="display: none;"
                          >
                              Copied!
                              <div class="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1 border-4 border-transparent border-t-black"></div>
                          </div>
                      </button>
                      
                      <button 
                          @click="copyDonation('SOL')" 
                          aria-label="Donate Solana (SOL)"
                          class="group relative p-2 rounded-lg bg-gray-800/50 hover:bg-teal-400/10 border border-gray-700 hover:border-teal-400/50 transition-all focus:outline-none focus:ring-2 focus:ring-teal-400">
                          <svg class="w-4 h-4 md:w-5 md:h-5 text-gray-400 group-hover:text-teal-400 group-focus:text-teal-400" viewBox="0 0 398 312" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"/></svg>
                          <div 
                              x-show="copiedDonation === 'SOL'" 
                              x-bind="tooltipTransition"
                              class="absolute bottom-full mb-4 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] py-1 px-3 rounded-md shadow-lg border border-gray-700 whitespace-nowrap z-50 pointer-events-none"
                              style="display: none;"
                          >
                              Copied!
                              <div class="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1 border-4 border-transparent border-t-black"></div>
                          </div>
                      </button>
                  </div>
              </div>
          </div>

      </div>
  </body>
  </html>
  `;
}