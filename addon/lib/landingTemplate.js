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

button {
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

button:hover {
   box-shadow: none;
}

button:active {
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
   position: absolute;
   left: 0;
   bottom: 4vh;
   width: 100%;
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
  height: 3.5vh;
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
`;
const { Providers } = require('./manifest');
const { SortOptions } = require('./sort');
const { DebridOptions } = require('../moch/options');
const { MochOptions } = require('../moch/moch');

function landingTemplate(manifest, config = {}) {
  const providers = config.providers || [];
  const sort = config.sort || SortOptions.options.qualitySeeders.key;
  const limit = config.limit || '';

  const debridOptions = config[DebridOptions.key] || [];
  const realDebridApiKey = config[MochOptions.realdebrid.key] || '';
  const allDebridApiKey = config[MochOptions.alldebrid.key] || '';
  const putioKey = config[MochOptions.putio.key] || '';
  const putioClientId = putioKey.replace(/@.*/, '');
  const putioToken = putioKey.replace(/.*@/, '');

  const background = manifest.background || 'https://dl.strem.io/addon-background.jpg';
  const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png';
  const contactHTML = manifest.contactEmail ?
      `<div class="contact">
         <p>Contact ${manifest.name} creator:</p>
         <a href="mailto:${manifest.contactEmail}">${manifest.contactEmail}</a>
      </div>` : '';
  const providersHTML = Providers
      .map(provider => `<option value="${provider.toLowerCase()}">${provider}</option>`)
      .join('\n');
  const sortOptionsHTML = Object.values(SortOptions.options)
      .map((option, i) => `<option value="${option.key}" ${i === 0 ? 'selected' : ''}>${option.description}</option>`)
      .join('\n');
  const debridOptionsHTML = Object.values(DebridOptions.options)
      .map((option) => `<option value="${option.key}">${option.description}</option>`)
      .join('\n');
  const stylizedTypes = manifest.types
      .map(t => t[0].toUpperCase() + t.slice(1) + (t !== 'series' ? 's' : ''));

  return `
   <!DOCTYPE html>
   <html style="background-image: url(${background});">

   <head>
      <meta charset="utf-8">
      <title>${manifest.name} - Stremio Addon</title>
      <link rel="shortcut icon" href="${logo}" type="image/x-icon">
      <link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
      <script src="https://code.jquery.com/jquery-3.5.1.slim.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.1/dist/umd/popper.min.js"></script>
      <script src="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/js/bootstrap.min.js"></script>
      <link href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css" rel="stylesheet" >
      <script src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-multiselect/0.9.15/js/bootstrap-multiselect.min.js"></script>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-multiselect/0.9.15/css/bootstrap-multiselect.css" rel="stylesheet"/>
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
         <select id="iProviders" class="input" name="providers[]" multiple="multiple">
            ${providersHTML}
         </select>
         
         <label class="label" for="iSort">Sorting:</label>
         <select id="iSort" class="input" onchange="sortModeChange()">
           ${sortOptionsHTML}
         </select>
         
         <label class="label" id="iLimitLabel" for="iLimit">Max results per quality:</label>
         <input type="text" id="iLimit" onchange="generateInstallLink()" class="input"  placeholder="All results">
         
         <label class="label" for="iDebridOptions">Debrid options:</label>
         <select id="iDebridOptions" class="input" name="debridOptions[]" multiple="multiple">
            ${debridOptionsHTML}
         </select>
         
         <label class="label" for="iRealDebrid">RealDebrid API Key (Find it <a href='https://real-debrid.com/apitoken' target="_blank">here</a>):</label>
         <input type="text" id="iRealDebrid" onchange="generateInstallLink()" class="input">
         
         <label class="label" for="iAllDebrid">AllDebrid API Key (Create it <a href='https://alldebrid.com/apikeys' target="_blank">here</a>):</label>
         <input type="text" id="iAllDebrid" onchange="generateInstallLink()" class="input">
         
         <label class="label" for="iPutio">Put.io ClientId and Token (Create new OAuth App <a href='https://app.put.io/settings/account/oauth/apps' target="_blank">here</a>):</label>
         <input type="text" id="iPutioClientId" placeholder="ClientId" onchange="generateInstallLink()" class="input">
         <input type="text" id="iPutioToken" placeholder="Token" onchange="generateInstallLink()" class="input">
         
         <div class="separator"></div>

         <a id="installLink" class="install-link" href="#">
            <button name="Install">INSTALL</button>
         </a>
         ${contactHTML}
      </div>
      <script type="text/javascript">
          $(document).ready(function() {
              $('#iProviders').multiselect({ 
                  nonSelectedText: 'All providers',
                  onChange: () => generateInstallLink()
              });
              $('#iProviders').multiselect('select', [${providers.map(provider => '"' + provider + '"')}]);
              $('#iDebridOptions').multiselect({ 
                  nonSelectedText: 'None',
                  onChange: () => generateInstallLink()
              });
              $('#iDebridOptions').multiselect('select', [${debridOptions.map(option => '"' + option + '"')}]);
              $('#iRealDebrid').val("${realDebridApiKey}");
              $('#iAllDebrid').val("${allDebridApiKey}");
              $('#iPutioClientId').val("${putioClientId}");
              $('#iPutioToken').val("${putioToken}");
              $('#iSort').val("${sort}");
              $('#iLimit').val("${limit}");
              generateInstallLink();
          });
          
          function sortModeChange() {
            if (['${SortOptions.options.seeders.key}', '${SortOptions.options.size.key}'].includes($('#iSort').val())) {
              $("#iLimitLabel").text("Max results:");
            } else {
              $("#iLimitLabel").text("Max results per quality:");
            }
            generateInstallLink();
          }
          
          function generateInstallLink() {
              const providersValue = $('#iProviders').val().join(',') || '';
              const sortValue = $('#iSort').val() || '';
              const limitValue = $('#iLimit').val() || '';
              
              const debridOptionsValue = $('#iDebridOptions').val().join(',') || '';
              const realDebridValue = $('#iRealDebrid').val() || '';
              const allDebridValue = $('#iAllDebrid').val() || '';
              const putioClientIdValue = $('#iPutioClientId').val() || '';
              const putioTokenValue = $('#iPutioToken').val() || '';
              
              
              const providers = providersValue.length && providersValue;
              const sort = sortValue !== '${SortOptions.options.qualitySeeders.key}' && sortValue;
              const limit = /^[1-9][0-9]*$/.test(limitValue) && limitValue;
              
              const debridOptions = debridOptionsValue.length && debridOptionsValue.trim();
              const realDebrid = realDebridValue.length && realDebridValue.trim();
              const allDebrid = allDebridValue.length && allDebridValue.trim();
              const putio = putioClientIdValue.length && putioTokenValue.length && putioClientIdValue.trim() + '@' + putioTokenValue.trim();
              
              const configurationValue = [
                    ['providers', providers], 
                    ['${SortOptions.key}', sort], 
                    ['limit', limit], 
                    ['${DebridOptions.key}', debridOptions], 
                    ['${MochOptions.realdebrid.key}', realDebrid], 
                    ['${MochOptions.alldebrid.key}', allDebrid], 
                    ['${MochOptions.putio.key}', putio]
                  ].filter(([_, value]) => value.length).map(([key, value]) => key + '=' + value).join('|');
              const configuration = configurationValue && configurationValue.length ? '/' + configurationValue : '';
              installLink.href = 'stremio://' + window.location.host + configuration + '/manifest.json';
          }
      </script>
	</body>

	</html>`
}

module.exports = landingTemplate;