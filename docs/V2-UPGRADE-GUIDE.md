# Upgrade to @tomphttp/bare-server-node v2.x

@tomphttp/bare-server-node v2.x brings about many changes that provide a more stable API. However, many of these changes mean that apps written for @tomphttp/bare-server-node v1.x needs to be updated to work with @tomphttp/bare-server-node v2.x. This document helps you make this transition.

## No more default exports

In v2.x, the way you import the library has been updated for better maintainability.

You should import `createBareServer` using named imports instead.

Use the following code snippet to update the way you import the library:

```js
// old way
import createBareServer from '@tomphttp/bare-server-node';

// new way
import { createBareServer } from '@tomphttp/bare-server-node';
```
