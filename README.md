# bosco-core

Basic bosco object

### How to use it

```js
// import the object
var Bosco = require('bosco-core');

// create an instance. The dirname will be used to reference the package.json
// For example reading the description, version of bosco etc.
// It is also expected that you have bosco commands under the directory subfolder commands
var bosco = new Bosco(__dirname);

// This is used to read the command from the command line. If the command used is not found, you will get an error with an helper message
bosco.initWithCommandLineArgs();

// you run the command
bosco.run();
```
