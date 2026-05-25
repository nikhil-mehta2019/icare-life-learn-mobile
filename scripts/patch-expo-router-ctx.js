const fs = require('fs');
const path = require('path');

const routerDir = path.join(__dirname, '..', 'node_modules', 'expo-router');

const patched = `export const ctx = require.context(
  '../../app',
  true,
  /.*/
);
`;

['_ctx.android.tsx', '_ctx.ios.tsx', '_ctx.tsx'].forEach((file) => {
  const filePath = path.join(routerDir, file);
  if (fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, patched, 'utf8');
    console.log('Patched', file);
  }
});
