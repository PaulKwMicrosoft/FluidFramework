/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

module.exports = {
	extends: ["@fluidframework/eslint-config-fluid"],
    "parserOptions": {
        "project": ["./tsconfig.json", "./src/test/tsconfig.json"]
    },
	rules: {
		"@typescript-eslint/strict-boolean-expressions": "off",
		"no-null/no-null": "off",
        "tsdoc/syntax": "off",
	},
};
