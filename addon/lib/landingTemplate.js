const STYLESHEET = `
* {
   box-sizing: border-box;
}

body,
html {
   margin: 0;
   padding: 0;
   width: 100%;
   height: 100%
}

html {
   background-size: auto 100%;
   background-size: cover;
   background-position: center center;
   background-repeat: repeat-y;
}

body {
   display: flex;
   background-color: transparent;
   font-family: 'Open Sans', Arial, sans-serif;
   color: white;
}

h1 {
   font-size: 4.5vh;
   font-weight: 700;
}

h2 {
   font-size: 2.2vh;
   font-weight: normal;
   font-style: italic;
   opacity: 0.8;
}

h3 {
   font-size: 2.2vh;
}

h1,
h2,
h3,
p,
label {
   margin: 0;
   text-shadow: 0 0 1vh rgba(0, 0, 0, 0.15);
}

p {
   font-size: 1.75vh;
}

ul {
   font-size: 1.75vh;
   margin: 0;
   margin-top: 1vh;
   padding-left: 3vh;
}

a {
   color: green
}

a.install-link {
   text-decoration: none
}

.install-button {
   border: 0;
   outline: 0;
   color: white;
   background: #8A5AAB;
   padding: 1.2vh 3.5vh;
   margin: auto;
   text-align: center;
   font-family: 'Open Sans', Arial, sans-serif;
   font-size: 2.2vh;
   font-weight: 600;
   cursor: pointer;
   display: block;
   box-shadow: 0 0.5vh 1vh rgba(0, 0, 0, 0.2);
   transition: box-shadow 0.1s ease-in-out;
}

.install-button:hover {
   box-shadow: none;
}

.install-button:active {
   box-shadow: 0 0 0 0.5vh white inset;
}

#addon {
   width: 90vh;
   margin: auto;
   padding-left: 10%;
   padding-right: 10%;
   background: rgba(0, 0, 0, 0.60);
}

.logo {
   height: 14vh;
   width: 14vh;
   margin: auto;
   margin-bottom: 3vh;
}

.logo img {
   width: 100%;
}

.name, .version {
   display: inline-block;
   vertical-align: top;
}

.name {
   line-height: 5vh;
}

.version {
   position: absolute;
   line-height: 5vh;
   margin-left: 1vh;
   opacity: 0.8;
}

.contact {
   left: 0;
   bottom: 4vh;
   width: 100%;
   margin-top: 1vh;
   text-align: center;
}

.contact a {
   font-size: 1.4vh;
   font-style: italic;
}

.separator {
   margin-bottom: 4vh;
}

.label {
  font-size: 2.2vh;
  font-weight: 600;
  padding: 0;
  line-height: inherit;
}

.btn-group, .multiselect-container {
  width: 100%;
}

.btn {
  text-align: left;
}

.multiselect-container {
  border: 0;
  border-radius: 0;
}

.input, .btn {
  width: 100%;
  margin: auto;
  margin-bottom: 10px;
  padding: 6px 12px;
  border: 0;
  border-radius: 0;
  outline: 0;
  color: #333;
  background-color: rgb(255, 255, 255);
  box-shadow: 0 0.5vh 1vh rgba(0, 0, 0, 0.2);
}

.input:focus, .btn:focus {
  outline: none; 
  box-shadow: 0 0 0 2pt rgb(30, 144, 255, 0.7);
}
`;
import { Providers, QualityFilter, SizeFilter } from './filter.js';
import { SortOptions } from './sort.js';
import { LanguageOptions } from './languages.js';
import { DebridOptions } from '../moch/options.js';
import { MochOptions } from '../moch/moch.js';
import { PreConfigurations } from './configuration.js';

export default function landingTemplate(manifest, config = {}) {
  const providers = config[Providers.key] || Providers.options.map(provider => provider.key);
  const sort = config[SortOptions.key] || SortOptions.options.qualitySeeders.key;
  const languages = config[LanguageOptions.key] || [];
  const qualityFilters = config[QualityFilter.key] || [];
  const sizeFilter = (config[SizeFilter.key] || []).join(',');
  const limit = config.limit || '';

  const debridProvider = Object.keys(MochOptions).find(mochKey => config[mochKey]);
  const debridOptions = config[DebridOptions.key] || [];
  const realDebridApiKey = config[MochOptions.realdebrid.key] || '';
  const premiumizeApiKey = config[MochOptions.premiumize.key] || '';
  const allDebridApiKey = config[MochOptions.alldebrid.key] || '';
  const debridLinkApiKey = config[MochOptions.debridlink.key] || '';
  const offcloudApiKey = config[MochOptions.offcloud.key] || '';
  const torboxApiKey = config[MochOptions.torbox.key] || '';
  const putioKey = config[MochOptions.putio.key] || '';
  const putioClientId = putioKey.replace(/@.*/, '');
  const putioToken = putioKey.replace(/.*@/, '');

  const background = manifest.background || 'https://dl.strem.io/addon-background.jpg';
  const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png';
  const providersHTML = Providers.options
      .map(provider => `<option value="${provider.key}">${provider.foreign ? provider.foreign + ' ' : ''}${provider.label}</option>`)
      .join('\n');
  const sortOptionsHTML = Object.values(SortOptions.options)
      .map((option, i) => `<option value="${option.key}" ${i === 0 ? 'selected' : ''}>${option.description}</option>`)
      .join('\n');
  const languagesOptionsHTML = LanguageOptions.options
      .map((option, i) => `<option value="${option.key}">${option.label}</option>`)
      .join('\n');
  const qualityFiltersHTML = Object.values(QualityFilter.options)
      .map(option => `<option value="${option.key}">${option.label}</option>`)
      .join('\n');
  const debridProvidersHTML = Object.values(MochOptions)
      .map(moch => `<option value="${moch.key}">${moch.name}</option>`)
      .join('\n');
  const debridOptionsHTML = Object.values(DebridOptions.options)
      .map(option => `<option value="${option.key}">${option.description}</option>`)
      .join('\n');
  const stylizedTypes = manifest.types
      .map(t => t[0].toUpperCase() + t.slice(1) + (t !== 'series' ? 's' : ''));
  const preConfigurationObject = Object.entries(PreConfigurations)
      .map(([key, config]) => `${key}: '${config.serialized}'`)
      .join(',');

  return `
   <!DOCTYPE html>
   <html style="background-image: url(${background});">

   <head>
      <meta charset="utf-8">
      <title>${manifest.name} - Stremio Addon</title>
      <link rel="shortcut icon" href="${logo}" type="image/x-icon">
      <link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
      <script src="https://code.jquery.com/jquery-3.6.4.slim.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.1/dist/umd/popper.min.js"></script>
      <script src="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/js/bootstrap.min.js"></script>
      <link href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css" rel="stylesheet" >
      <script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-multiselect/1.1.2/js/bootstrap-multiselect.min.js"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-multiselect/1.1.2/css/bootstrap-multiselect.css" rel="stylesheet"/>
      <style>${STYLESHEET}</style>
   </head>

	<body>
      <div id="addon">
         <div class="logo">
            <img src="${logo}">
         </div>
         <h1 class="name">${manifest.name}</h1>
         <h2 class="version">${manifest.version || '0.0.0'}</h2>
         <h2 class="description">${manifest.description || ''}</h2>

         <div class="separator"></div>

         <h3 class="gives">This addon has more :</h3>
         <ul>
            ${stylizedTypes.map(t => `<li>${t}</li>`).join('')}
         </ul>

         <div class="separator"></div>
         
         <label class="label" for="iProviders">Providers:</label>
         <select id="iProviders" class="input" onchange="generateInstallLink()" name="providers[]" multiple="multiple">
            ${providersHTML}
         </select>
         
         <label class="label" for="iSort">Sorting:</label>
         <select id="iSort" class="input" onchange="sortModeChange()">
           ${sortOptionsHTML}
         </select>
         
         <label class="label" for="iLanguages">Priority foreign language:</label>
         <select id="iLanguages" class="input" onchange="generateInstallLink()" name="languages[]" multiple="multiple" title="Streams with the selected dubs/subs language will be shown on the top">
           ${languagesOptionsHTML}
         </select>
         
         <label class="label" for="iQualityFilter">Exclude qualities/resolutions:</label>
         <select id="iQualityFilter" class="input" onchange="generateInstallLink()" name="qualityFilters[]" multiple="multiple">
            ${qualityFiltersHTML}
         </select>
         
         <label class="label" id="iLimitLabel" for="iLimit">Max results per quality:</label>
         <input type="text" inputmode="numeric" pattern="[0-9]*" id="iLimit" onchange="generateInstallLink()" class="input" placeholder="All results">
         
         <label class="label" id="iSizeFilterLabel" for="iSizeFilter">Video size limit:</label>
         <input type="text" pattern="([0-9.]*(?:MB|GB),?)+" id="iSizeFilter" onchange="generateInstallLink()" class="input" placeholder="No limit" title="Returned videos cannot exceed this size, use comma to have different size for movies and series. Examples: 5GB ; 800MB ; 10GB,2GB">
         
         
         <label class="label" for="iDebridProviders">Debrid provider:</label>
         <select id="iDebridProviders" class="input" onchange="debridProvidersChange()">
            <option value="none" selected>None</option>
            ${debridProvidersHTML}
         </select>
         
         <div id="dRealDebrid">
           <label class="label" for="iRealDebrid">RealDebrid API Key (Find it <a href='https://real-debrid.com/apitoken' target="_blank">here</a>):</label>
           <input type="text" id="iRealDebrid" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dAllDebrid">
           <label class="label" for="iAllDebrid">AllDebrid API Key (Create it <a href='https://alldebrid.com/apikeys' target="_blank">here</a>):</label>
           <input type="text" id="iAllDebrid" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dPremiumize">
           <label class="label" for="iPremiumize">Premiumize API Key (Find it <a href='https://www.premiumize.me/account' target="_blank">here</a>):</label>
           <input type="text" id="iPremiumize" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dDebridLink">
           <label class="label" for="iDebridLink">DebridLink API Key (Find it <a href='https://debrid-link.fr/webapp/apikey' target="_blank">here</a>):</label>
           <input type="text" id="iDebridLink" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dOffcloud">
           <label class="label" for="iOffcloud">Offcloud API Key (Find it <a href='https://offcloud.com/#/account' target="_blank">here</a>):</label>
           <input type="text" id="iOffcloud" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dTorbox">
           <label class="label" for="iTorbox">TorBox API Key (Find it <a href='https://torbox.app/settings' target="_blank">here</a>):</label>
           <input type="text" id="iTorbox" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dPutio">
           <label class="label" for="iPutio">Put.io ClientId and Token (Create new OAuth App <a href='https://app.put.io/oauth' target="_blank">here</a>):</label>
           <input type="text" id="iPutioClientId" placeholder="ClientId" onchange="generateInstallLink()" class="input">
           <input type="text" id="iPutioToken" placeholder="Token" onchange="generateInstallLink()" class="input">
         </div>
         
         <div id="dDebridOptions">
           <label class="label" for="iDebridOptions">Debrid options:</label>
           <select id="iDebridOptions" class="input" onchange="generateInstallLink()" name="debridOptions[]" multiple="multiple">
              ${debridOptionsHTML}
           </select>
         </div>
         
         <div class="separator"></div>

         <a id="installLink" class="install-link" href="#">
            <button name="Install" class="install-button">INSTALL</button>
         </a>
         <div class="contact">
           <p>Or paste into Stremio search bar after clicking install</p>
        </div>
        
        <div class="separator"></div>
      </div>
      <script type="text/javascript">
          $(document).ready(function() {
              const isTvMedia = window.matchMedia("tv").matches;
              const isTvAgent = /\\b(?:tv|wv)\\b/i.test(navigator.userAgent)
              const isDesktopMedia = window.matchMedia("(pointer:fine)").matches;
              if (isDesktopMedia && !isTvMedia && !isTvAgent) {
                $('#iProviders').multiselect({ 
                    nonSelectedText: 'All providers',
                    buttonTextAlignment: 'left',
                    onChange: () => generateInstallLink()
                });
                $('#iProviders').multiselect('select', [${providers.map(provider => '"' + provider + '"')}]);
                $('#iLanguages').multiselect({ 
                    nonSelectedText: 'None',
                    buttonTextAlignment: 'left',
                    onChange: () => generateInstallLink()
                });
                $('#iLanguages').multiselect('select', [${languages.map(language => '"' + language + '"')}]);
                $('#iQualityFilter').multiselect({ 
                    nonSelectedText: 'None',
                    buttonTextAlignment: 'left',
                    onChange: () => generateInstallLink()
                });
                $('#iQualityFilter').multiselect('select', [${qualityFilters.map(filter => '"' + filter + '"')}]);
                $('#iDebridOptions').multiselect({ 
                    nonSelectedText: 'None',
                    buttonTextAlignment: 'left',
                    onChange: () => generateInstallLink()
                });
                $('#iDebridOptions').multiselect('select', [${debridOptions.map(option => '"' + option + '"')}]);
              } else {
                $('#iProviders').val([${providers.map(provider => '"' + provider + '"')}]);
                $('#iLanguages').val([${languages.map(language => '"' + language + '"')}]);
                $('#iQualityFilter').val([${qualityFilters.map(filter => '"' + filter + '"')}]);
                $('#iDebridOptions').val([${debridOptions.map(option => '"' + option + '"')}]);
              }
              $('#iDebridProviders').val("${debridProvider || 'none'}");
              $('#iRealDebrid').val("${realDebridApiKey}");
              $('#iPremiumize').val("${premiumizeApiKey}");
              $('#iAllDebrid').val("${allDebridApiKey}");
              $('#iDebridLink').val("${debridLinkApiKey}");
              $('#iOffcloud').val("${offcloudApiKey}");
              $('#iTorbox').val("${torboxApiKey}");
              $('#iPutioClientId').val("${putioClientId}");
              $('#iPutioToken').val("${putioToken}");
              $('#iSort').val("${sort}");
              $('#iLimit').val("${limit}");
              $('#iSizeFilter').val("${sizeFilter}");
              generateInstallLink();
              debridProvidersChange();
          });
          
          function sortModeChange() {
            if (['${SortOptions.options.seeders.key}', '${SortOptions.options.size.key}'].includes($('#iSort').val())) {
              $("#iLimitLabel").text("Max results:");
            } else {
              $("#iLimitLabel").text("Max results per quality:");
            }
            generateInstallLink();
          }
          
          function debridProvidersChange() {
            const provider = $('#iDebridProviders').val()
            $('#dDebridOptions').toggle(provider !== 'none');
            $('#dRealDebrid').toggle(provider === '${MochOptions.realdebrid.key}');
            $('#dPremiumize').toggle(provider === '${MochOptions.premiumize.key}');
            $('#dAllDebrid').toggle(provider === '${MochOptions.alldebrid.key}');
            $('#dDebridLink').toggle(provider === '${MochOptions.debridlink.key}');
            $('#dOffcloud').toggle(provider === '${MochOptions.offcloud.key}');
            $('#dTorbox').toggle(provider === '${MochOptions.torbox.key}');
            $('#dPutio').toggle(provider === '${MochOptions.putio.key}');
          }
          
          function generateInstallLink() {
              const providersList = $('#iProviders').val() || [];
              const providersValue = providersList.join(',');
              const qualityFilterValue = $('#iQualityFilter').val().join(',') || '';
              const sortValue = $('#iSort').val() || '';
              const languagesValue = $('#iLanguages').val().join(',') || [];
              const limitValue = $('#iLimit').val() || '';
              const sizeFilterValue = $('#iSizeFilter').val() || '';
              
              const debridOptionsValue = $('#iDebridOptions').val().join(',') || '';
              const realDebridValue = $('#iRealDebrid').val() || '';
              const allDebridValue = $('#iAllDebrid').val() || '';
              const debridLinkValue = $('#iDebridLink').val() || ''
              const premiumizeValue = $('#iPremiumize').val() || '';
              const offcloudValue = $('#iOffcloud').val() || '';
              const torboxValue = $('#iTorbox').val() || '';
              const putioClientIdValue = $('#iPutioClientId').val() || '';
              const putioTokenValue = $('#iPutioToken').val() || '';
              
              
              const providers = providersList.length && providersList.length < ${Providers.options.length} && providersValue;
              const qualityFilters = qualityFilterValue.length && qualityFilterValue;
              const sort = sortValue !== '${SortOptions.options.qualitySeeders.key}' && sortValue;
              const languages = languagesValue.length && languagesValue;
              const limit = /^[1-9][0-9]{0,2}$/.test(limitValue) && limitValue;
              const sizeFilter = sizeFilterValue.length && sizeFilterValue;
              
              const debridOptions = debridOptionsValue.length && debridOptionsValue.trim();
              const realDebrid = realDebridValue.length && realDebridValue.trim();
              const premiumize = premiumizeValue.length && premiumizeValue.trim();
              const allDebrid = allDebridValue.length && allDebridValue.trim();
              const debridLink = debridLinkValue.length && debridLinkValue.trim();
              const offcloud = offcloudValue.length && offcloudValue.trim();
              const torbox = torboxValue.length && torboxValue.trim();
              const putio = putioClientIdValue.length && putioTokenValue.length && putioClientIdValue.trim() + '@' + putioTokenValue.trim();

              const preConfigurations = { 
                ${preConfigurationObject}
              };
              let configurationValue = [
                    ['${Providers.key}', providers],
                    ['${SortOptions.key}', sort],
                    ['${LanguageOptions.key}', languages],
                    ['${QualityFilter.key}', qualityFilters],
                    ['limit', limit],
                    ['${SizeFilter.key}', sizeFilter],
                    ['${DebridOptions.key}', debridOptions], 
                    ['${MochOptions.realdebrid.key}', realDebrid],
                    ['${MochOptions.premiumize.key}', premiumize],
                    ['${MochOptions.alldebrid.key}', allDebrid],
                    ['${MochOptions.debridlink.key}', debridLink],
                    ['${MochOptions.offcloud.key}', offcloud],
                    ['${MochOptions.torbox.key}', torbox],
                    ['${MochOptions.putio.key}', putio]
                  ].filter(([_, value]) => value.length).map(([key, value]) => key + '=' + value).join('|');
              configurationValue = Object.entries(preConfigurations)
                  .filter(([key, value]) => value === configurationValue)
                  .map(([key, value]) => key)[0] || configurationValue;
              const configuration = configurationValue && configurationValue.length ? '/' + configurationValue : '';
              const location = window.location.host + configuration + '/manifest.json'
              installLink.href = 'stremio://' + location;
          }

          installLink.addEventListener('click', function() {
             navigator.clipboard.writeText(installLink.href.replace('stremio://', 'https://'));
          });
      </script>
	</body>

	</html>`
}
