import axios from 'axios'
import Redis from 'ioredis'
import qs from 'qs'
import fs from 'fs'
import path from 'path';
import { chromium } from 'playwright'
import * as cheerio from 'cheerio';

const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    password: '1234567',
    db: 0
});

redis.on('connect', () => {
});


async function runBrowser()
{
    const browser = await chromium.launch({ headless: true,executablePath: '/usr/bin/chromium',args: [
      '--no-sandbox',
      '--disable-gpu', 
    ]});
  const page = await browser.newPage();

  try {
    await page.goto('http://www.cduestc.cn/eams/loginExt.action');
    await page.fill('#username', process.env.kc_user);
    await page.fill('#password', process.env.ke_password);
    const captchaElement = await page.locator('img[src="/eams/captcha/image.action"]');
    const captchaImage = await captchaElement.screenshot()
    const captchaImageBase64 = captchaImage.toString('base64');
    const uploadResponse = await axios.post('https://2captcha.com/in.php', {
          key: process.env.captcha_key,
          method: 'base64',
          body: captchaImageBase64,
          json: 1,
          type: 'ImageToTextTask',
        });
    if (uploadResponse.data.status !== 1) {
      throw new Error(`验证码上传失败: ${uploadResponse.data.request}`);
    }
    const captchaID = uploadResponse.data.request;
    let result = '';
        while (true) {
          const getResultResponse = await axios.get(`https://2captcha.com/res.php?key=${process.env.captcha_key}=get&id=${captchaID}&json=1`);
          if (getResultResponse.data.status === 1) {
            result = getResultResponse.data.request;
            break;
          }else if (getResultResponse.data.request === 'ERROR_CAPTCHA_UNSOLVABLE') {
        throw new Error('验证码无法识别');
        }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
           console.log('识别验证码', result);
        await page.type('#captcha_response', result);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
        const pageSource = await page.content();
        const errorMessageRegex = /<span>(.*?)<\/span>/;
        const match = pageSource.match(errorMessageRegex);
        if (match && match[1]) {
            const errorText = match[1];
            if (errorText == '验证码不正确') {
                console.log(`错误消息: ${errorText}`);
                await browser.close();
                return runBrowser();
            } else if (errorText == '账户不存在' || errorText == '密码错误') {
                console.log(`错误消息: ${errorText}`);
                await browser.close();
                process.exit();
            }
        }
        const cookies = await page.context().cookies();
        const cookieW = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        const exists = await redis.exists('kc_cookie');
        await redis.set('kc_cookie', cookieW);
        console.log(`Cookie: ${cookieW}`);
        await browser.close();
        return cjcx();
  } catch (error) {
    console.error('登录时发生错误:', error);
  } finally {
    await browser.close();
  }
}



async function cjcx() {
    try {
        const cookie = await redis.get('kc_cookie');
        const cjcx = axios.create({
            headers: {
                'Cookie': cookie,
            },
        });
        const response = await cjcx.get('http://www.cduestc.cn/eams/teach/grade/course/person!search.action?semesterId=' + '138' + '&projectType=&_=' + (new Date().getTime()));
        const pageContent = response.data;
        if (pageContent.includes('<title>上海树维信息科技有限公司教学管理系统</title>')) {
         console.log('cookie失效')
         return runBrowser();
      }
        const $ = cheerio.load(response.data);
        const extractedData: any[] = [];
        $('tbody tr').each((index, element) => {
            const row = $(element);
            const 学年学期 = row.find('td:nth-child(1)').text().trim();
            const 课程代码 = row.find('td:nth-child(2)').text().trim();
            const 课程类别 = row.find('td:nth-child(5)').text().trim();
            const 学分 = row.find('td:nth-child(6)').text().trim();
            const 课程名称 = row.find('td:nth-child(4)').text().trim();
            const 总评成绩 = row.find('td:nth-child(8)').text().trim();
            const 最终成绩 = row.find('td:nth-child(9)').text().trim();
            const courseData = {
                学年学期,
                课程代码,
                课程类别,
                学分,
                课程名称,
                总评成绩,
                最终成绩,
            };
            extractedData.push(courseData);
        });
        const storedData = await redis.get('kc_cj');
        let storedCourses = storedData ? JSON.parse(storedData) : [];
        let dataChanged = false;
        const newStoredCourses = [];
        let changeMessage = ''; 
        for (let i = 0; i < extractedData.length; i++) {
            const course = extractedData[i];
            const storedCourse = storedCourses.find((storedCourse: any) => storedCourse.课程代码 === course.课程代码);
            if (!storedCourse || storedCourse.总评成绩 !== course.总评成绩) {
                console.log(`课程 ${course.课程名称} 的成绩发生变化`);
                dataChanged = true;
                changeMessage += `课程名称: ${course.课程名称}\n成绩: ${course.总评成绩}\n\n`;
                const index = storedCourses.findIndex((storedCourse: any) => storedCourse.课程代码 === course.课程代码);
                if (index !== -1) {
                    storedCourses[index] = course; 
                } else {
                    storedCourses.push(course);
                }
            }
            newStoredCourses.push(course.课程代码);
        }

        for (let i = 0; i < storedCourses.length; i++) {
            const storedCourse = storedCourses[i];
            if (!newStoredCourses.includes(storedCourse.课程代码)) {
                dataChanged = true;
                storedCourses.splice(i, 1); 
                i--; 
            }
        }
        if (dataChanged) {
            const currentData = JSON.stringify(storedCourses);
            await redis.set('kc_cj', currentData);
                 //自己申请api
                await axios.post('https://iyuu.cn/xxxxxxx.send', null, {
        params: {
            text: '成绩更新通知',
            desp: changeMessage
        }
    })
    .then(response => {
        console.log('推送成功:', response.data);
    })
    .catch(error => {
        console.error('推送失败:', error);
    });

        } else {
            console.log('成绩没有变化');
        }

    } catch (error) {
        console.error('发生错误：', error);
    }
}

async function main() {
    await cjcx();
    process.exit();
}

main();