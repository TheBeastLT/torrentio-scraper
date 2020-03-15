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
   background-repeat: no-repeat
}

body {
   display: flex;
   background: rgba(0, 0, 0, 0.60);
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
   color: white
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
   width: 40vh;
   margin: auto;
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

.multiselect-container {
  border: 0;
  border-radius: 0;
}

.input, .btn {
  height: 3.5vh;
  width: 100%;
  margin: auto;
  padding: 6px 12px;
  border: 0;
  border-radius: 0;
  outline: 0;
  color: #333;
  box-shadow: 0 0.5vh 1vh rgba(0, 0, 0, 0.2);
}
`;
const { Providers } = require('./manifest');

function landingTemplate(manifest, providers = [], realDebridApiKey = '') {
  console.log(providers);
  console.log(realDebridApiKey);
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
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.3.1/jquery.min.js"></script>
      <script src="https://davidstutz.de/bootstrap-multiselect/docs/js/bootstrap-3.3.2.min.js"></script>
      <link href="https://davidstutz.de/bootstrap-multiselect/docs/css/bootstrap-3.3.2.min.css" rel="stylesheet"/>
      <script src="https://davidstutz.de/bootstrap-multiselect/dist/js/bootstrap-multiselect.js"></script>
      <link href="https://davidstutz.de/bootstrap-multiselect/dist/css/bootstrap-multiselect.css" rel="stylesheet"/>
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
         
         <label class="label" for="iRealDebrid">RealDebrid API Key:</label>
         <input type="text" id="iRealDebrid" onchange="generateInstallLink()" class="input">
         
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
              $('#iRealDebrid').val("${realDebridApiKey}");
              generateInstallLink();
          });
          
          function generateInstallLink() {
              const providersValue = $('#iProviders').val().join(',');
              const realDebridValue = $('#iRealDebrid').val();
              const providers = providersValue && providersValue.length ? 'providers=' + providersValue : '';
              const realDebrid = realDebridValue && realDebridValue.length ? 'realrebrid='+realDebridValue : '';
              const configurationValue = [providers, realDebrid].filter(value => value.length).join('|');
              const configuration = configurationValue && configurationValue.length ? '/' + configurationValue : '';
              installLink.href = 'stremio://' + window.location.host + configuration + '/manifest.json';
          }
      </script>
	</body>

	</html>`
}

module.exports = landingTemplate;