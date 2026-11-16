// Run against Vite with mocked APIs; never reads or changes the photo library.
// PUPPETEER_MODULE may point to an existing Puppeteer installation.
import assert from 'node:assert/strict'
const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE || 'puppeteer')
const browser = await puppeteer.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
})
const base = process.env.TEST_URL || 'http://127.0.0.1:5186'
const oldPath = '/photos/202611——呼和浩特2'
const newPath = '/photos/20261114_西岸艺术博览中心'
const otherPath = '/photos/另一个目录'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture({ twoFolders = false, holdScan = false } = {}) {
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  await page.setViewport({ width: 1440, height: 1000 })
  await page.evaluateOnNewDocument(() => localStorage.clear())
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const state = {
    folders: [{ id: 1, path: oldPath, photo_count: 1, alive_count: 1 }],
    scanning: false, done: false, calls: [], pendingShots: [], delayShots: false,
    failDeleteIds: [], failCompleteIds: [],
  }
  if (twoFolders) state.folders.push({ id: 3, path: otherPath, photo_count: 1, alive_count: 1 })
  state.finishScan = () => {
    state.done = true
    state.folders = [{ id: 2, path: newPath, photo_count: 1, alive_count: 1 }, ...state.folders]
  }
  await page.setRequestInterception(true)
  page.on('request', async request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return request.continue()
    const body = request.postData() ? JSON.parse(request.postData()) : null
    state.calls.push({ path: url.pathname, method: request.method(), body, folder: url.searchParams.get('folder') })
    const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) })
    if (url.pathname === '/api/folders') return respond({ folders: state.folders })
    if (url.pathname === '/api/pick-folder') return respond({ path: newPath })
    if (url.pathname === '/api/pick-files') return respond({ folder: newPath, files: [newPath + '/NEW_PHOTO.JPG'] })
    if (url.pathname === '/api/scan' && request.method() === 'POST') {
      state.scanning = true
      if (!holdScan) setTimeout(state.finishScan, 200)
      return respond({ started: true })
    }
    if (url.pathname === '/api/scan/status') return respond({ phase: state.done ? 'done' : state.scanning ? 'scanning' : 'idle' })
    if (url.pathname === '/api/shots') {
      const isNew = url.searchParams.get('folder') === newPath
      const isOther = url.searchParams.get('folder') === otherPath
      const result = { items: [{ primary_id: isNew ? 2 : isOther ? 3 : 1, stem: isNew ? 'NEW_PHOTO' : isOther ? 'OTHER_PHOTO' : 'OLD_PHOTO', formats: ['JPG'], tags: [], rating: 1 }], total: 1 }
      if (state.delayShots) { state.pendingShots.push(() => respond(result)); return }
      return respond(result)
    }
    if (url.pathname === '/api/tags') return respond({ tags: ['选片/A', '选片/B', '选片/C', '选片/D'].map((name, id) => ({ id, name })) })
    if (url.pathname === '/api/history') return respond({ batches: [] })
    if (/^\/api\/folders\/\d+\/complete$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/')[3])
      if (state.failCompleteIds.includes(id)) return respond({ detail: 'simulated failure' }, 500)
      state.folders = state.folders.map(f => f.id === id ? { ...f, completed_at: body.completed ? 1 : null } : f)
      return respond({ folder_id: id, completed: body.completed })
    }
    if (/^\/api\/folders\/\d+$/.test(url.pathname) && request.method() === 'DELETE') {
      const id = Number(url.pathname.split('/').at(-1))
      if (state.failDeleteIds.includes(id)) return respond({ detail: 'simulated failure' }, 500)
      state.folders = state.folders.filter(f => f.id !== id)
      return respond({ deleted_folder_id: id })
    }
    if (url.pathname.startsWith('/api/thumb/')) return request.respond({ status: 204 })
    return respond({})
  })
  await page.goto(base)
  await page.waitForSelector('.home-task')
  return { page, state, errors }
}

async function clickText(page, scope, text) {
  await page.evaluate(({ scope, text }) => {
    const button = [...document.querySelectorAll(`${scope} button`)].find(b => b.textContent.trim() === text)
    if (!button || button.disabled) throw new Error(`Button unavailable: ${text}`)
    button.click()
  }, { scope, text })
}

try {
  for (const chooseFiles of [false, true]) {
    const { page, state, errors } = await fixture()
    await page.click(chooseFiles ? '.home-card:nth-child(2)' : '.home-card:first-child')
    await page.waitForFunction(() => document.querySelector('.topbar input')?.value.includes('西岸艺术'))
    await page.waitForFunction(() => [...document.querySelectorAll('.topbar button')].some(b => b.textContent === '扫描+AI' && !b.disabled))
    await sleep(200)
    const stems = await page.$$eval('.main .tile .stem', els => els.map(el => el.textContent))
    assert.deepEqual(stems, ['NEW_PHOTO'], `${chooseFiles ? '选文件' : '选文件夹'}扫描后必须显示新目录照片; requests=${JSON.stringify(state.calls.filter(c => c.path === '/api/shots'))}`)
    assert.deepEqual(errors, [])
    console.log(`PASS: ${chooseFiles ? '选文件' : '选文件夹'}扫描完成显示实际目录`)
    await page.close()
  }
  {
    const { page, state, errors } = await fixture({ holdScan: true })
    await page.click('.home-card:first-child')
    await page.waitForSelector('.sidebar .folder-row')
    await page.click('.sidebar .folder-row')
    await page.waitForSelector('#tile-1')
    state.finishScan()
    await page.waitForFunction(() => [...document.querySelectorAll('.topbar button')].some(b => b.textContent === '扫描+AI' && !b.disabled))
    assert.equal(await page.$eval('.topbar input', el => el.value), oldPath)
    assert.equal(await page.$eval('.main .stem', el => el.textContent), 'OLD_PHOTO')
    assert.deepEqual(errors, [])
    console.log('PASS: 后台扫描完成不抢走当前浏览目录')
    await page.close()
  }
  {
    const { page, state, errors } = await fixture({ twoFolders: true })
    await page.click('.home-task')
    await page.waitForSelector('#tile-1')
    state.delayShots = true
    // Start an old-folder refresh, then navigate before it resolves.
    await page.select('.sidebar select:has(option[value="iso"])', 'iso')
    await sleep(100)
    state.delayShots = false
    await page.evaluate(path => [...document.querySelectorAll('.folder-row')].find(el => el.title === path).click(), otherPath)
    await page.waitForSelector('#tile-3')
    assert(state.pendingShots.length > 0)
    await Promise.all(state.pendingShots.map(resolve => resolve()))
    await sleep(150)
    assert.equal(await page.$eval('.topbar input', el => el.value), otherPath)
    assert.equal(await page.$eval('.main .stem', el => el.textContent), 'OTHER_PHOTO')
    assert.deepEqual(errors, [])
    console.log('PASS: 旧目录慢响应不能覆盖新目录')
    await page.close()
  }
  for (const sidebar of [false, true]) {
    const { page, state, errors } = await fixture({ twoFolders: true })
    if (sidebar) { await page.click('.home-task'); await page.waitForSelector('#tile-1') }
    const scope = sidebar ? '.sidebar' : '.home-history'
    await clickText(page, scope, '多选')
    await page.click(`${scope} .folder-select-all input`)
    assert.equal(await page.$$eval(`${scope} input[aria-label^="选择目录"]:checked`, els => els.length), 2)
    await clickText(page, scope, '标记已完成')
    await page.waitForFunction(scope => document.querySelector(`${scope} .folder-selection-count`)?.textContent === '已选 0 个', {}, scope)
    assert(state.folders.every(f => f.completed_at))
    await page.click(`${scope} .folder-select-all input`)
    await clickText(page, scope, '改为待捡图')
    await page.waitForFunction(scope => document.querySelector(`${scope} .folder-selection-count`)?.textContent === '已选 0 个', {}, scope)
    assert(state.folders.every(f => !f.completed_at))
    await page.click(`${scope} .folder-select-all input`)
    if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TEST_SCREENSHOT_DIR}/birdye-${sidebar ? 'sidebar' : 'home'}-multiselect.png`, fullPage: true })
    page.once('dialog', dialog => { assert(dialog.message().includes('原始照片')); dialog.dismiss() })
    await clickText(page, scope, '删除目录信息')
    await sleep(100)
    assert.equal(state.calls.filter(c => c.method === 'DELETE').length, 0, '取消不能删除记录')
    assert.equal(state.folders.length, 2)
    state.failDeleteIds = [3]
    page.on('dialog', dialog => dialog.accept())
    await clickText(page, scope, '删除目录信息')
    await page.waitForFunction(scope => document.querySelector(`${scope} .folder-selection-count`)?.textContent === '已选 1 个', {}, scope)
    assert.deepEqual(state.folders.map(f => f.id), [3], '部分失败只保留失败目录')
    state.failDeleteIds = []
    await clickText(page, scope, '删除目录信息')
    await page.waitForFunction(scope => document.querySelector(`${scope} .folder-selection-count`)?.textContent === '已选 0 个', {}, scope)
    assert.equal(state.folders.length, 0)
    if (sidebar) {
      await page.waitForFunction(() => document.querySelector('.topbar input')?.value === '')
      assert.equal(await page.$$eval('.main .tile', els => els.length), 0)
    }
    await clickText(page, scope, '退出多选')
    assert.equal(await page.$(`${scope} .folder-selection-toolbar`), null)
    assert.deepEqual(errors, [])
    console.log(`PASS: ${sidebar ? '侧栏' : '首页'}批量完成/恢复、取消删除、部分失败重试、删除全部`)
    await page.close()
  }
} finally {
  await browser.close()
}
