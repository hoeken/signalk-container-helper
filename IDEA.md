This is the folder for a new project, tentatively named 'signalk-container-helper', which is intended to be an abstraction library for building plugins that use the signalk-container plugin to manage containers. The goal is to abstract away the common container operations required for building plugins such as pull/start/healthcheck/stop.

The plugin will be written in Node js and eventually published as an npm module. It will be intended for developers of containerized signalk plugins.

In order to do that, lets first look at some of the more popular signalk plugins that use signalk-container and extract the commonly used features and methods into a helper class to simplify plugin operation.

Please examine each of the following plugins in order to come up with a spec and a plan.

- mayara-server-signalk-plugin
- signalk-backup
- signalk-doctor
- signalk-updater
