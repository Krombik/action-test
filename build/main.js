var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import * as core from '@actions/core';
import * as github from '@actions/github';
import { XMLParser } from 'fast-xml-parser';
import { parse } from 'csv-parse/sync';
import { handleGenerate, handleGetFile, handleUnique } from './utils';
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        core.info('start');
        const baseBranch = 'main';
        const MASK_SYMBOL = '0';
        const INTERNAL = '/** @internal */\n';
        // const branchName = core.getInput('branch-name');
        const octokit = github.getOctokit(core.getInput('my-token')).rest;
        const myRepo = github.context.repo;
        const getFile = handleGetFile(octokit, myRepo);
        try {
            const { files, addFile } = handleGenerate(JSON.parse((yield getFile('.prettierrc', true)).content), getFile);
            core.info('prettier config loaded');
            const [withoutFormatObj, addToWithoutFormatObj] = handleUnique();
            const [formatObj, addToFormatObj] = handleUnique();
            const parserOptions = {
                columns: true,
                delimiter: ';',
                relax_quotes: true,
                relax_column_count: true,
                trim: true,
                skip_empty_lines: true,
                skip_records_with_empty_values: true,
            };
            const googleRepo = { owner: 'google', repo: 'libphonenumber' };
            const metadata = parse((yield getFile('resources/metadata/metadata.csv', true, googleRepo))
                .content, Object.assign(Object.assign({}, parserOptions), { onRecord(record) {
                    if (record['Main Region'] !== '001') {
                        return record;
                    }
                } }));
            core.info('metadata.csv loaded');
            for (let i = 0; i < metadata.length; i++) {
                const callingCode = metadata[i]['Calling Code'];
                const formatsCvs = yield getFile(`resources/metadata/${callingCode}/formats.csv`, false, googleRepo);
                const formats = formatsCvs && parse(formatsCvs.content, parserOptions);
                parse((yield getFile(`resources/metadata/${callingCode}/ranges.csv`, true, googleRepo)).content, Object.assign({ onRecord(record) {
                        if (record.Type === 'MOBILE' ||
                            record.Type === 'FIXED_LINE_OR_MOBILE') {
                            const regions = record.Regions.split(',');
                            const format = record.Format;
                            const arr = record.Length.split(/[-,]/);
                            const length = +arr[arr.length - 1];
                            for (let i = regions.length; i--;) {
                                const iso2 = regions[i];
                                if (formats && format) {
                                    addToFormatObj(iso2, format, () => {
                                        const value = formats.find(item => item.Id === format).International;
                                        if (value && value.indexOf('{X>}') == -1) {
                                            return {
                                                format: value.replace(/[*X]/g, MASK_SYMBOL),
                                                length,
                                                index: -1,
                                            };
                                        }
                                    });
                                }
                                else {
                                    addToWithoutFormatObj(iso2, length, () => ({
                                        format: Array.from({ length }, () => MASK_SYMBOL).join(''),
                                        length,
                                        index: -1,
                                    }));
                                }
                            }
                        }
                    } }, parserOptions));
            }
            for (const key in withoutFormatObj) {
                if (!(key in formatObj)) {
                    formatObj[key] = withoutFormatObj[key];
                }
            }
            for (const key in formatObj) {
                const format = formatObj[key];
                if (format.length > 1) {
                    const set = new Set();
                    const arr = [];
                    for (let i = 0; i < format.length; i++) {
                        const item = format[i];
                        const length = item.length;
                        if (!set.has(length)) {
                            set.add(length);
                            arr.push(item);
                        }
                    }
                    arr.sort((a, b) => a.length - b.length);
                    formatObj[key] = arr.filter((item, index, self) => {
                        return !self.some((kek, j) => j != index && kek.format.startsWith(item.format));
                    });
                }
            }
            const formatsList = [];
            for (const key in formatObj) {
                const formats = formatObj[key];
                for (let i = 0; i < formats.length; i++) {
                    const format = formats[i];
                    let index = -1;
                    for (let j = 0; j < formatsList.length; j++) {
                        const existingFormat = formatsList[j];
                        if (existingFormat.format.startsWith(format.format)) {
                            existingFormat.repeatingTimes++;
                            index = j;
                            break;
                        }
                        else if (format.format.startsWith(existingFormat.format)) {
                            index = j;
                            existingFormat.format = format.format;
                            existingFormat.repeatingTimes++;
                            break;
                        }
                    }
                    if (index < 0) {
                        format.index = formatsList.length;
                        formatsList.push({ format: format.format, repeatingTimes: 0 });
                    }
                    else {
                        format.index = index;
                    }
                }
            }
            const { territories } = new XMLParser({
                ignoreAttributes: false,
                parseTagValue: false,
                allowBooleanAttributes: true,
                parseAttributeValue: false,
                attributeNamePrefix: '_',
                commentPropName: '__comment',
            }).parse((yield getFile('resources/PhoneNumberMetadata.xml', true, googleRepo))
                .content).phoneNumberMetadata;
            core.info('PhoneNumberMetadata.xml loaded');
            const nameDictionary = {};
            const iso2Dictionary = {};
            territories.__comment.forEach(str => {
                const item = /^ (.+) \((\w{2})\) $/.exec(str);
                if (item) {
                    const name = item[1];
                    const iso2 = item[2];
                    nameDictionary[name] = iso2;
                    iso2Dictionary[iso2] = name;
                }
            });
            iso2Dictionary.RU = '404';
            const data = territories.territory;
            const map = {};
            for (let i = 0; i < data.length; i++) {
                const { mobile, _id, _countryCode, _leadingDigits, _mainCountryForCode } = data[i];
                if (_id === '001' || !mobile) {
                    continue;
                }
                const country = {
                    iso2: _id,
                    pattern: mobile.nationalNumberPattern.replace(/[ \n]/g, ''),
                    formats: formatObj[_id],
                    leadingDigits: _leadingDigits,
                    mainCountryForCode: _mainCountryForCode === 'true',
                };
                if (_countryCode in map) {
                    const arr = map[_countryCode];
                    const index = arr.findIndex(country.leadingDigits
                        ? item => item.leadingDigits === country.leadingDigits
                        : item => item.pattern === country.pattern);
                    if (index < 0) {
                        arr.push(country);
                    }
                    else if (country.mainCountryForCode) {
                        arr[index] = country;
                    }
                }
                else {
                    map[_countryCode] = [country];
                }
            }
            let formatsFile = '';
            const formatsVariableSet = new Set();
            let longestNumber = 0;
            let longestCallingCode = 0;
            const countries = new Set();
            for (const key in map) {
                const item = map[key];
                if (key.length > longestCallingCode) {
                    longestCallingCode = key.length;
                }
                for (let i = 0; i < item.length; i++) {
                    const country = item[i];
                    let _import = `import {${"PhoneNumberFormat" /* Names.PHONE_NUMBER_FORMAT */}} from '../../types';\n\n`;
                    const iso2 = country.iso2.toUpperCase();
                    const countryNameComment = `/** ${iso2Dictionary[iso2]} */\n`;
                    let str = `${countryNameComment}const ${iso2}: ${"PhoneNumberFormat" /* Names.PHONE_NUMBER_FORMAT */}=[${key},'${country.iso2}',${country.formats
                        .reduce((acc, item) => {
                        if (item.length > longestNumber) {
                            longestNumber = item.length;
                        }
                        acc.push(item.length);
                        const variable = formatsList[item.index];
                        if (variable.repeatingTimes) {
                            const variableName = `format${item.index}`;
                            if (!formatsVariableSet.has(variableName)) {
                                formatsVariableSet.add(variableName);
                                formatsFile += `${INTERNAL}export const ${variableName}='${variable.format}';\n\n`;
                            }
                            _import += `import {${variableName}} from '../../utils/${"constants" /* Names.CONSTANTS */}';\n\n`;
                            acc.push(variableName);
                        }
                        else {
                            acc.push(`'${item.format}'`);
                        }
                        return acc;
                    }, [])
                        .join(',')}`;
                    if (item.length > 1 && !country.mainCountryForCode) {
                        str += `,/^(?:${country.leadingDigits ||
                            country.pattern.replace(/\\d(?:\{\d+\})?/g, '')})/`;
                    }
                    countries.add(iso2);
                    yield addFile(`src/${"phoneNumberFormats" /* Names.PHONE_NUMBER_FORMATS */}/${iso2}/index.ts`, `${_import}${str}];\n\nexport default ${iso2};`);
                    yield addFile(`src/${"phoneValidationPatterns" /* Names.PHONE_VALIDATION_PATTERNS */}/${iso2}/index.ts`, `${countryNameComment}const ${iso2}=/^(?:${country.pattern})$/;\n\nexport default ${iso2};`);
                }
            }
            if (countries.size) {
                const arr1 = Array.from(countries).sort();
                yield addFile(`src/${"phoneValidationPatterns" /* Names.PHONE_VALIDATION_PATTERNS */}/index.ts`, `${arr1
                    .map(iso2 => `import ${iso2} from './${iso2}';`)
                    .join('\n')}\n\nconst ${"phoneValidationPatterns" /* Names.PHONE_VALIDATION_PATTERNS */}={${arr1.join(',')}};\n\nexport default ${"phoneValidationPatterns" /* Names.PHONE_VALIDATION_PATTERNS */};`);
                yield addFile(`src/types/${"iso2" /* Names.ISO2 */}.ts`, `type ISO2=${arr1
                    .map(item => `'${item}'`)
                    .join('|')};\n\nexport default ISO2;`);
                const arr2 = Object.keys(nameDictionary)
                    .sort()
                    .reduce((acc, name) => {
                    const iso2 = nameDictionary[name];
                    if (countries.has(iso2)) {
                        acc.push(iso2);
                    }
                    return acc;
                }, []);
                yield addFile(`src/${"phoneNumberUtils" /* Names.PHONE_NUMBER_UTILS */}/index.ts`, `${arr2
                    .map(iso2 => `import ${iso2} from '../${"phoneNumberFormats" /* Names.PHONE_NUMBER_FORMATS */}/${iso2}';`)
                    .join('\n')}\n\nimport ${"createPhoneNumberUtils" /* Names.CREATE_PHONE_NUMBER_UTILS */} from '../${"createPhoneNumberUtils" /* Names.CREATE_PHONE_NUMBER_UTILS */}';\n\nconst ${"phoneNumberUtils" /* Names.PHONE_NUMBER_UTILS */} = ${"createPhoneNumberUtils" /* Names.CREATE_PHONE_NUMBER_UTILS */}([${arr2.join(',')}]);\n\nexport default ${"phoneNumberUtils" /* Names.PHONE_NUMBER_UTILS */};`);
            }
            yield addFile(`src/utils/${"constants" /* Names.CONSTANTS */}.ts`, `${INTERNAL}export const MAX_CALLING_CODE_LENGTH=${longestCallingCode};\n\n${INTERNAL}export const MAX_NUMBER_LENGTH=${longestNumber};\n\n${INTERNAL}export const MASK_SYMBOL='${MASK_SYMBOL}';\n\n${formatsFile}`);
            if (files.length) {
                const newBranch = 'next';
                const commitSHA = (yield octokit.git.createRef(Object.assign(Object.assign({}, myRepo), { ref: `refs/heads/${newBranch}`, sha: (yield octokit.repos.getBranch(Object.assign(Object.assign({}, myRepo), { branch: baseBranch }))).data.commit.sha }))).data.object.sha;
                for (let i = 0; i < files.length; i++) {
                    yield octokit.repos.createOrUpdateFileContents(Object.assign(Object.assign(Object.assign({}, myRepo), files[i]), { message: 'Update file', branch: newBranch }));
                }
                const commitMessage = 'Commit changes';
                yield octokit.git.createCommit(Object.assign(Object.assign({}, myRepo), { message: commitMessage, tree: commitSHA, parents: [commitSHA] }));
                const pullRequestTitle = 'New Pull Request';
                const pullRequestBody = 'This is a new pull request';
                yield octokit.pulls.create(Object.assign(Object.assign({}, myRepo), { title: pullRequestTitle, body: pullRequestBody, head: newBranch, base: baseBranch }));
            }
            core.info(`updated ${files.length} files`);
        }
        catch (error) {
            core.setFailed(error.message);
        }
        // try {
        //   const myToken = core.getInput('my-token');
        //   // const branchName = core.getInput('branch-name');
        //   const octokit = github.getOctokit(myToken).rest;
        //   try {
        //     // try {
        //     //   await octokit.repos.getContent({
        //     //     owner: 'google',
        //     //     repo: 'libphonenumber',
        //     //     path: 'resources/PhoneNumberMetadata.xml',
        //     //   });
        //     //   core.info('metadata is successful');
        //     // } catch (error: any) {
        //     //   core.setFailed(`Error: ${error.message}`);
        //     // }
        //     const { owner, repo } = github.context.repo;
        //     try {
        //       const fileContent = (
        //         await octokit.repos.getContent({
        //           owner,
        //           repo,
        //           path: '.prettierrc',
        //         })
        //       ).data;
        //       if (!('content' in fileContent)) {
        //         core.setFailed(`not a file`);
        //         return;
        //       }
        //       core.info(Buffer.from(fileContent.content, 'base64').toString('utf8'));
        //     } catch (error: any) {
        //       core.setFailed(`Error: ${error.message}`);
        //     }
        //     const baseBranch = 'main'; // The base branch you want to create the new branch from
        //     const newBranch = 'new-branch'; // The name of the new branch you want to create
        //     const filePath = 'file.txt'; // The path to the file you want to modify
        //     // Step 1: Get the existing file content
        //     const fileContent = (
        //       await octokit.repos.getContent({
        //         owner,
        //         repo,
        //         path: filePath,
        //       })
        //     ).data;
        //     if (!('content' in fileContent)) {
        //       return;
        //     }
        //     const existingContent = Buffer.from(
        //       fileContent.content,
        //       'base64',
        //     ).toString('utf8');
        //     // Step 2: Compare existing content with new content
        //     const newContent = 'New content'; // Replace with your desired content
        //     core.info(existingContent);
        //     core.info(newContent);
        //     if (existingContent === newContent) {
        //       core.info(
        //         'Content is identical. Skipping commit and pull request creation.',
        //       );
        //       return;
        //     }
        //     // Step 3: Create a new branch
        //     await octokit.git.createRef({
        //       owner,
        //       repo,
        //       ref: `refs/heads/${newBranch}`,
        //       sha: (
        //         await octokit.repos.getBranch({ owner, repo, branch: baseBranch })
        //       ).data.commit.sha,
        //     });
        //     core.info('ref created');
        //     // Step 4: Modify the file
        //     const updatedContent = Buffer.from(newContent, 'utf8').toString('base64');
        //     await octokit.repos.createOrUpdateFileContents({
        //       owner,
        //       repo,
        //       path: filePath,
        //       message: 'Update file',
        //       content: updatedContent,
        //       sha: fileContent.sha,
        //       branch: newBranch,
        //     });
        //     core.info('file updated');
        //     // Step 5: Create a new commit
        //     const commitMessage = 'Commit changes';
        //     await octokit.git.createCommit({
        //       owner,
        //       repo,
        //       message: commitMessage,
        //       tree: (
        //         await octokit.repos.getBranch({ owner, repo, branch: newBranch })
        //       ).data.commit.commit.tree.sha,
        //       parents: [
        //         (await octokit.repos.getBranch({ owner, repo, branch: newBranch }))
        //           .data.commit.sha,
        //       ],
        //     });
        //     core.info('comitted');
        //     // Step 6: Create a pull request
        //     const pullRequestTitle = 'New Pull Request';
        //     const pullRequestBody = 'This is a new pull request';
        //     const pullRequest = await octokit.pulls.create({
        //       owner,
        //       repo,
        //       title: pullRequestTitle,
        //       body: pullRequestBody,
        //       head: newBranch,
        //       base: baseBranch,
        //     });
        //     core.info(`Pull request created: ${pullRequest.data.html_url}`);
        //   } catch (error: any) {
        //     core.setFailed(`Error: ${error.message}`);
        //   }
        //   core.setOutput('time', new Date().toTimeString());
        // } catch (error) {
        //   if (error instanceof Error) core.setFailed(error.message);
        // }
    });
}
run();
//# sourceMappingURL=main.js.map