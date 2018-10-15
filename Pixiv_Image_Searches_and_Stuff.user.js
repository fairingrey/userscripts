// ==UserScript==
// @name         Pixiv Image Searches and Stuff
// @namespace    https://github.com/fairingrey/userscripts
// @description  Searches Danbooru for pixiv IDs and source mismatches, adds IQDB image search links, and filters images based on pixiv favorites. Heavily modified from Mango's script (also named Pixiv Image Searches and Stuff).
// @match        *://www.pixiv.net/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js
// @version      2018.10.02
// ==/UserScript==

/* You must be logged into Danbooru (or your preferred site mirror) for all features to work! */

var danbooruURL = "https://danbooru.donmai.us/"; //Change this to your preferred subdomain if desired (sonohara, hijiribe). Make sure to include the final backslash. It may break if your selected mirror does not support HTTPS
var iqdbURL = "https://danbooru.iqdb.org/?url="; //Replace with "https://danbooru.iqdb.org/?url=" (Danbooru) or "https://iqdb.org/?url=" (multi-service) to add IQDB search links (replaces bookmark counts)
var sauceURL = "http://saucenao.com/search.php?db=999&url=";
var addIQDBSearch = true; //IQDB search button
var addSourceSearch = true; //Danbooru post search (looks for matching pixiv IDs); **Requires GM_xmlhttpRequest**
var ignoreMismatch = false; //ignores mismatch highlighting
var ignoreBadRevision = false; //ignores alternate highlighting of source mismatch tagged "bad_revision"
var hidePopularSection = true; //Hides the popular section that can get in the way due to this script
var debugConsole = false; //Enables program feedback through the development console

/* CSS Styling + Other Options */
var styleSourceFound = "color:green; font-weight: bold;";
var styleSourceMismatch = "color:purple; font-weight: bold;";
var styleSourceBadRevision = "color:darkorange; font-weight: bold; font-style: italic;";
var styleSourceMissing = "color:red;";
var sourceTimeout = 20; //seconds to wait before retrying query
var maxAttempts = 10; //# of times to try a query before completely giving up on source searches
var mangaCheckPeriod = 2000; //Interval (in milliseconds) between each check on manga images
var thumbCheckPeriod = 1000; //Interval (in milliseconds) between each check on search/bookmark pages
var pixivTransparentSrc = "https://s.pximg.net/www/images/common/transparent.gif";

//////////////////////////////////////////////////////////////////////////////////////

var minFavs = 0,
    anyBookmarks = false,
    favList = [];

if (typeof (GM_getValue) == "undefined" || !GM_getValue('a', 'b')) {
    GM_getValue = function (name, defV) {
        var value = localStorage.getItem("pisas." + name);
        return (value === null ? defV : value);
    };
    GM_setValue = function (name, value) {
        localStorage.setItem("pisas." + name, value);
    };
    GM_deleteValue = function (name) {
        localStorage.removeItem("pisas." + name);
    };
}

if (typeof (custom) != "undefined")
    custom();

var mangaSeenlist = [];

//Source search requires GM_xmlhttpRequest()
if (addSourceSearch && typeof (GM_xmlhttpRequest) == "undefined")
    addSourceSearch = false;

//Manga images have to be handled specially
if (location.search.indexOf("mode=manga") >= 0) {
    asyncProcessManga();
} else if (window == window.top) //Don't run if inside an iframe
{
    //Add ability to set minFavs inside Search Options
    var addSearch = document.getElementById("wrapper");
    if ($(".search-result-information").length && addSearch) {
        anyBookmarks = true;

        //Load "minFavs" setting
        if (GM_getValue("minFavs"))
            minFavs = parseInt(GM_getValue("minFavs"));

        debuglog("minFavs:", minFavs);
        //Set option
        /*
        addSearch = addSearch.parentNode.parentNode;
        */
        var favTr = document.createElement("tr");
        favTr.style.display = "none";
        favTr.appendChild(document.createElement("th")).textContent = "Minimum favorites (script)";
        var favInput = favTr.appendChild(document.createElement("td")).appendChild(document.createElement("input"));
        favInput.type = "text";
        favInput.value = "" + minFavs;
        favInput.addEventListener("input", function () {
            if (/^ *\d+ *$/.test(this.value) && (minFavs = parseInt(this.value, 10)) > 0)
                GM_setValue("minFavs", "" + minFavs);
            else {
                GM_deleteValue("minFavs");
                minFavs = 0;
            }

            for (let i = 0; i < favList.length; i++) {
                if (favList[i].favcount < minFavs)
                    favList[i].thumb.style.display = "none";
                else
                    favList[i].thumb.style.removeProperty("display");
            }
        }, true);
        addSearch.parentNode.insertBefore(favTr, addSearch);
    }

    //Prevent added links sometimes being hidden for thumbnails with long titles
    var style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = 'li.image-item {overflow:visible !important}\n';
    if (hidePopularSection) {
        style.innerHTML += '._premium-lead-tag-search-bar, ._premium-lead-popular-d-body {display:none !important; height:0; width:0; }\n';
    }
    document.getElementsByTagName('head')[0].appendChild(style);

    processThumbs([document]);

    //Monitor for changes caused by other scripts
    new MutationObserver(function (mutationSet) {
        mutationSet.forEach(function (mutation) {
            processThumbs(mutation.addedNodes);
        });
    }).observe(document.body, {
        childList: true,
        subtree: true
    });
}

//====================================== Functions ======================================

function debuglog(args) {
    if (debugConsole) {
        console.log.apply(this, arguments);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function asyncProcessManga() {
    debuglog("Starting image check...");
    while (true) {
        let timages = document.querySelectorAll(".item-container img");
        let isdone = true;
        for (let k = 0; k < timages.length; k++) {
            if (timages[k].src === pixivTransparentSrc) {
                isdone = false;
            }
            debuglog(timages[k].src);
        }
        processManga();
        if (isdone) {
            break;
        } else {
            debuglog("Sleeping...");
            await sleep(mangaCheckPeriod);
        }
    }
    debuglog("All images finished loading...");
}

function processManga() {
    var searchID = addSourceSearch && location.search.match(/illust_id=(\d+)/);
    if (searchID) {
        var thumbList = [],
            images = document.querySelectorAll(".item-container img"),
            transparentCount = 0;
        for (let i = 0; i < images.length; i++) {
            if (images[i].src === pixivTransparentSrc) {
                transparentCount++;
                continue;
            }
            if (mangaSeenlist.indexOf(images[i].src) >= 0) {
                continue;
            }
            thumbList.push({
                link: images[i].parentNode.appendChild(document.createElement("div")).appendChild(document.createElement("a")),
                pixiv_id: searchID[1],
                src: images[i].src,
                page: i
            });
            mangaSeenlist.push(images[i].src);
        }
        debuglog("Thumbs:", thumbList.length, "Transparent:", transparentCount);
        if (thumbList.length === 0 && transparentCount > 0) {
            return -1;
        }
        sourceSearch(thumbList);
        return thumbList.length;
    }
}

async function asyncProcessThumbs() {
    GM_setValue('asyncProcessThumbs', true);
    debuglog("Starting async thumbs processing...");
    while (true) {
        if ($('[pisas=working]').length == 0) {
            debuglog("Finished async thumbs processing...");
            GM_setValue('asyncProcessThumbs', false);
            return;
        }
        var thumbSearch = $('[pisas=working][style*=background-image]');
        var thumbList = [];
        for (let i = 0; i < thumbSearch.length; i++) {
            var thumbImg = thumbSearch[i];
            var thumbPage = thumbImg.parentNode;
            if (location.pathname.includes("/member_illust.php") && location.search.search('/?mode=medium') > 0) {
                var thumbCont = thumbPage.parentNode;
            } else if (location.pathname.includes("/member.php") || location.pathname.includes("/member_illust.php")) {
                var thumbCont = thumbPage.parentNode.parentNode;
            } else {
                var thumbCont = thumbPage.parentNode.parentNode.parentNode;
            }
            var sourceContainer = thumbCont;

            var bookmarkCount = 0;
            var bookmarkLink = thumbCont.querySelector("a[href*='bookmark_detail.php']");
            var bookmarkLink2;
            debuglog("Bookmark:", bookmarkLink !== null);

            thumbImg.src = thumbImg.style['background-image'].match(/url\("([^"]+)"\)/)[1];
            debuglog("Source:", thumbImg.src);

            if (addIQDBSearch) {
                bookmarkLink2 = document.createElement("a");
                bookmarkLink2.className = "bookmark-count search-link";
                if (anyBookmarks) {
                    bookmarkLink2.className += " ui-tooltip";
                    bookmarkLink2.setAttribute("data-tooltip", "0 bookmarks");
                }
            }

            if (bookmarkLink) {
                //Thumb has bookmark info
                bookmarkCount = parseInt(bookmarkLink.getAttribute("data-tooltip", "x").replace(/([^\d]+)/g, '')) || 1;
                sourceContainer = bookmarkLink.parentNode;
                if (bookmarkLink2) {
                    sourceContainer.appendChild(bookmarkLink2);
                }
            } else {
                //Dummy div to force new line when needed
                var dummydiv = document.createElement("div");
                dummydiv.style.justifyContent = 'center';
                dummydiv.style.display = 'flex';
                dummydiv.className = 'pisas-dummydiv';
                thumbCont.appendChild(dummydiv);
                sourceContainer = dummydiv;
                if (iqdbURL && addIQDBSearch) {
                    //Thumb doesn't have bookmark info.  Add a fake bookmark link to link with the IQDB.
                    bookmarkLink = document.createElement("a");
                    bookmarkLink.className = "bookmark-count search-link";
                    if (anyBookmarks) {
                        bookmarkLink.className += " ui-tooltip";
                        bookmarkLink.setAttribute("data-tooltip", "0 bookmarks");
                    }
                    //Append IQDB links inside dummy div
                    dummydiv.appendChild(bookmarkLink);
                    dummydiv.appendChild(bookmarkLink2);
                }
            }
            debuglog("Bookmark count:", bookmarkCount);

            if (anyBookmarks) {
                favList.push({
                    thumb: thumbCont,
                    favcount: bookmarkCount
                });
                if (bookmarkCount < minFavs) {
                    thumbCont.style.display = "none";
                }
            }

            if (iqdbURL && addIQDBSearch) {
                bookmarkLink.href = iqdbURL + thumbImg.src + (thumbPage ? "&fullimage=" + thumbPage.href : "");
                bookmarkLink.innerHTML = (bookmarkCount > 0 ? "(Q):" + bookmarkCount : "(Q)");
                bookmarkLink2.href = sauceURL + thumbImg.src + (thumbPage ? "&fullimage=" + thumbPage.href : "");
                bookmarkLink2.innerHTML = "(S)";
            }

            if (addSourceSearch && (!thumbImg.src || thumbImg.src.indexOf("/novel/") < 0) && pixivIllustID(thumbImg.src || thumbImg.href)) {
                sourceContainer.appendChild(document.createTextNode(" "));
                thumbList.push({
                    link: sourceContainer.appendChild(document.createElement("a")),
                    pixiv_id: pixivIllustID(thumbImg.src || thumbImg.href),
                    src: thumbImg.src || retrieveOGImageURL(),
                    page: -1
                });
            }

            thumbImg.setAttribute('pisas', 'done');
        }

        if (thumbList.length) {
            debuglog("Checking thumb source...");
            sourceSearch(thumbList);
        }

        debuglog("Sleeping...");
        await sleep(thumbCheckPeriod);
    }
}
GM_setValue('asyncProcessThumbs', false);

function processThumbs(target) {
    var thumbSearch = [],
        thumbList = [],
        launchAsyncThumbs = false;

    //Combine the results over all targets to minimize queries by source search
    for (let i = 0; i < target.length; i++) {
        //Take care not to match on profile images, like those shown in the "Following" box on user profiles...

        var xSearchA = document.evaluate("descendant-or-self::li/a[contains(@href,'mode=medium')]//img[not(@pisas)] | " +
            "descendant-or-self::div/a[contains(@href,'mode=medium')]/div[contains(@class,'js-lazyload') and not(@pisas)] |" +
            "descendant-or-self::li[@class='image-item']/a//img[not(@pisas)] | " +
            "descendant-or-self::section/a[contains(@href,'mode=medium')]//img[not(@pisas)] | " + //rankings
            "descendant-or-self::div/a[contains(@href,'mode=medium')]//img[not(@pisas)] | " +
            "descendant-or-self::div[@class='works_display']/a//img[not(@pisas)] | " +
            "descendant-or-self::div[@class='works_display']/div/img[not(@pisas)] | " +
            "descendant-or-self::div[@role='presentation']/a/img[not(@pisas)] | " +
            "descendant-or-self::li/a[contains(@class,'gtm-thumbnail-link')]/div[not(@pisas)] | " +
            "descendant-or-self::div[@class='works_display']//a[contains(@href,'mode=ugoira_view') and not(@pisas)] |" + //ugoira 'full size' icon
            "descendant-or-self::div/a[contains(@href,'mode=medium')]/div[not(@pisas)]",
            target[i], null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

        for (let j = 0; j < xSearchA.snapshotLength; j++) {
            (thumbSearch[thumbSearch.length] = xSearchA.snapshotItem(j)).setAttribute("pisas", "done");
        }
    }
    //Don't know why the above is not picking this out, but it's not picking this up with the mutation observers
    var xSearchB = document.evaluate("descendant-or-self::div[@role='presentation']/a/img[not(@pisas)]", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let j = 0; j < xSearchB.snapshotLength; j++) {
        (thumbSearch[thumbSearch.length] = xSearchB.snapshotItem(j)).setAttribute("pisas", "done");
    }
    if (thumbSearch.length === 0) {
        return;
    }
    for (let i = 0; i < thumbSearch.length; i++) {
        var thumbCont, thumbPage = null,
            thumbImg = thumbSearch[i];
        for (thumbCont = thumbImg.parentNode; !thumbCont.classList.contains("works_display"); thumbCont = thumbCont.parentNode) {
            if (thumbCont.tagName == "A") {
                thumbPage = thumbCont;
                if (location.pathname.includes("/search.php") || location.pathname.includes("/discovery") || location.pathname.includes("/bookmark_new_illust.php")) {
                    thumbCont = thumbPage.parentNode.parentNode.parentNode;
                } else if (location.pathname.includes("/member_illust.php") && location.search.search('/?mode=medium') > 0 && thumbImg.tagName == "IMG") {
                    thumbCont = thumbPage.parentNode.parentNode;
                } else {
                    thumbCont = thumbPage.parentNode;
                }
                break;
            }
        }
        thumbCont.style.marginBottom = "1em";
        var bookmarkCount = 0,
            bookmarkLink = thumbCont.querySelector("a[href*='bookmark_detail.php']");
        var bookmarkLink2;
        var sourceContainer = thumbCont;
        var launchAsyncThumbs = false;

        if ($(".pisas-dummydiv", thumbCont).length > 0) {
            debuglog("Already processed!");
            continue;
        }
        if (thumbImg.tagName == "IMG") {
            //Disable lazy loading
            if (thumbImg.getAttribute("data-src"))
                thumbImg.src = thumbImg.getAttribute("data-src");

            //Skip generic restricted thumbs
            if (thumbImg.src.indexOf("https://source.pixiv.net/") === 0)
                continue;

            //Skip special thumbs except on image pages (daily rankings on main page, ...)
            if (location.search.indexOf("mode=") < 0 && thumbPage && (thumbImg.src.indexOf("_100.") > 0 || thumbPage.href.indexOf("_ranking") > 0))
                continue;
        } else if (thumbImg.tagName == "DIV") {
            launchAsyncThumbs = true;
            thumbImg.setAttribute("pisas", "working");
            continue;
        }

        if (sauceURL && addIQDBSearch) {
            //Thumb doesn't have bookmark info.  Add a fake bookmark link to link with the IQDB.
            bookmarkLink2 = document.createElement("a");
            bookmarkLink2.className = "bookmark-count search-link";
            if (anyBookmarks) {
                bookmarkLink2.className += " ui-tooltip";
                bookmarkLink2.setAttribute("data-tooltip", "0 bookmarks");
            }
        }

        if (bookmarkLink) {
            //Thumb has bookmark info
            bookmarkCount = parseInt(bookmarkLink.getAttribute("data-tooltip", "x").replace(/([^\d]+)/g, '')) || 1;
            sourceContainer = bookmarkLink.parentNode;
            if (bookmarkLink2) {
                sourceContainer.appendChild(bookmarkLink2);
            }
        } else {
            //Dummy div to force new line when needed
            var dummydiv = document.createElement("div");
            dummydiv.style.justifyContent = 'center';
            dummydiv.style.display = 'flex';
            dummydiv.className = 'pisas-dummydiv';
            thumbCont.appendChild(dummydiv);
            sourceContainer = dummydiv;
            if (iqdbURL && addIQDBSearch) {
                //Thumb doesn't have bookmark info.  Add a fake bookmark link to link with the IQDB.
                bookmarkLink = document.createElement("a");
                bookmarkLink.className = "bookmark-count search-link";
                if (anyBookmarks) {
                    bookmarkLink.className += " ui-tooltip";
                    bookmarkLink.setAttribute("data-tooltip", "0 bookmarks");
                }
                //Append IQDB links inside dummy div
                dummydiv.appendChild(bookmarkLink);
                dummydiv.appendChild(bookmarkLink2);
            }
        }

        if (anyBookmarks) {
            favList.push({
                thumb: thumbCont,
                favcount: bookmarkCount
            });
            if (bookmarkCount < minFavs)
                thumbCont.style.display = "none";
        }

        if (iqdbURL && addIQDBSearch) {
            bookmarkLink.href = iqdbURL + thumbImg.src + (thumbPage ? "&fullimage=" + thumbPage.href : "");
            bookmarkLink.innerHTML = "(Q)" + (bookmarkCount == 0 ? "" : ':' + bookmarkCount.toString());
            bookmarkLink2.href = sauceURL + thumbImg.src + (thumbPage ? "&fullimage=" + thumbPage.href : "");
            bookmarkLink2.innerHTML = "(S)";
        }

        if (addSourceSearch && (!thumbImg.src || thumbImg.src.indexOf("/novel/") < 0) && pixivIllustID(thumbImg.src || thumbImg.href)) {
            sourceContainer.appendChild(document.createTextNode(" "));
            thumbList.push({
                link: sourceContainer.appendChild(document.createElement("a")),
                pixiv_id: pixivIllustID(thumbImg.src || thumbImg.href),
                src: thumbImg.src || retrieveOGImageURL(),
                page: -1
            });
        }
    }

    if (launchAsyncThumbs && !GM_getValue('asyncProcessThumbs')) {
        asyncProcessThumbs();
    }
    sourceSearch(thumbList);
}

function pixivIllustID(url) {
    var matcher = url.match(/\/(\d+)(_|\.)[^\/]+$/) || url.match(/illust_id=(\d+)/);
    return matcher && matcher[1];
}

function pixivPageNumber(url) {
    var matcher = url.match(/_p(\d+)(_master\d+)?\./);
    return matcher ? matcher[1] : "x";
}

/**
 * tokenize image URLs as per current pixiv URL schema
 * 1: date revised e.g. 2017/09/18/12/03/21 OR pixiv user id
 * 2: pixiv ID e.g. 65020694
 * 3: page number e.g. 3
 */
function tokenizePixivURL(url) {
    var matcher = url.match(/(\d+\/\d+\/\d+\/\d+\/\d+\/\d+)\/(\d+)(?:_big)?_p(\d+)(?:_\w*\d*)?[^\/]+$/);
    // handles ugoira
    if (!matcher) {
        matcher = url.match(/(\d+\/\d+\/\d+\/\d+\/\d+\/\d+)\/(\d+)(?:_big)?(?:_\w*\d*)?[^\/]+$/);
    }
    // handles older pixiv URLs (multiple)
    if (!matcher) matcher = url.match(/([a-z0-9]+)\/(\d+)(?:_big)?_p(\d+)(?:_\w*\d*)?[^\/]+$/);
    // handles older pixiv URLs (single)
    if (!matcher) {
        matcher = url.match(/([a-z0-9]+)\/(\d+)(?:_\w*\d*)?[^\/]+$/);
    }
    // handles direct HTML...
    if (!matcher) matcher = url.match(/illust_id=(\d+)/);
    if (matcher) matcher[3] = matcher[3] || 0;
    return matcher ? matcher : [url, "", "", ""]; // this should never be false, *hopefully*
}

/**
 * This is kind of cheating, but kinda have to figure out something for ugoira that's simple enough
 * retrieves the Opengraph image URL through the meta tag with property "og:image"
 */
function retrieveOGImageURL() {
    let metas = document.getElementsByTagName("meta");
    for (let i = 0; i < metas.length; i++) {
        if (metas[i].getAttribute("property") === "og:image")
            return metas[i].getAttribute("content");
    }
}

function sourceSearch(thumbList, attempt, page) {
    //thumbList[index] = { link, id, page? }

    if (page === undefined) {
        //First call.  Finish initialization
        attempt = page = 1;

        for (let i = 0; i < thumbList.length; i++) {
            if (!thumbList[i].status)
                thumbList[i].status = thumbList[i].link.parentNode.appendChild(document.createElement("span"));
            thumbList[i].link.textContent = "Searching...";
            thumbList[i].posts = [];
        }
    }

    if (attempt >= maxAttempts) {
        //Too many failures (or Downbooru); give up. :(
        for (let i = 0; i < thumbList.length; i++) {
            thumbList[i].status.style.display = "none";
            if (thumbList[i].link.textContent[0] != '(')
                thumbList[i].link.textContent = "(error)";
            thumbList[i].link.setAttribute("style", "color:blue; font-weight: bold;");
        }
        return;
    }

    //Is there actually anything to process?
    if (thumbList.length === 0)
        return;

    //Retry this call if timeout
    var retry = (function (a, b, c) {
        return function () {
            setTimeout(function () {
                sourceSearch(a, b, c);
            }, maxAttempts === 0 ? 0 : 1000);
        };
    })(thumbList, attempt + 1, page);
    var sourceTimer = setTimeout(retry, sourceTimeout * 1000);

    var idList = [];
    for (let i = 0; i < thumbList.length; i++) {
        thumbList[i].status.textContent = " [" + attempt + "]";
        if (idList.indexOf(thumbList[i].pixiv_id) < 0)
            idList.push(thumbList[i].pixiv_id);
    }

    GM_xmlhttpRequest({
        method: "GET",
        url: danbooruURL + 'posts.json?limit=100&tags=status:any+pixiv:' + idList.join() + '&page=' + page,
        onload: function (responseDetails) {
            clearTimeout(sourceTimer);

            //Check server response for errors
            var result = false,
                status = null;

            if (/^ *$/.test(responseDetails.responseText))
                status = "(error)"; //No content
            else if (responseDetails.responseText.indexOf("<title>Downbooru</title>") > 0) {
                addSourceSearch = maxAttempts = 0; //Give up
                status = "(Downbooru)";
            } else if (responseDetails.responseText.indexOf("<title>Failbooru</title>") > 0)
                status = "(Failbooru)";
            else try {
                result = JSON.parse(responseDetails.responseText);
                if (result.success !== false)
                    status = "Searching...";
                else {
                    status = "(" + (result.message || "error") + ")";
                    addSourceSearch = maxAttempts = 0; //Give up
                    result = false;
                }
            }
            catch (err) {
                result = false;
                status = "(parse error)";
            }

            //Update thumbnail messages
            for (let i = 0; i < thumbList.length; i++)
                thumbList[i].link.textContent = status;

            if (result === false)
                return retry(); //Hit an error; try again?

            //predefining some functions for good measure
            var setStyleSingle = function (thumb) {
                if (!ignoreMismatch && tokenizePixivURL(thumb.src)[1] !== tokenizePixivURL(thumb.posts[0].src)[1]) {
                    if (!ignoreBadRevision && thumb.posts[0].isBadRevision) {
                        thumb.link.setAttribute("style", styleSourceBadRevision);
                    } else {
                        thumb.link.setAttribute("style", styleSourceMismatch);
                    }
                } else {
                    thumb.link.setAttribute("style", styleSourceFound);
                }
            };

            var setStyleMulti = function (thumb) {
                if (ignoreMismatch) {
                    thumb.link.setAttribute("style", styleSourceFound);
                    return;
                }
                let postsMap = thumb.posts.map(function (x) {
                    return [tokenizePixivURL(x.src), x.isBadRevision];
                });
                let revDate = tokenizePixivURL(thumb.src)[1];
                let store = {};
                let matchArray = [];
                postsMap.forEach(function (post) {
                    store[post[0][3]] = store[post[0][3]] || [];
                    // page number -> [date revised, isBadRevision]
                    store[post[0][3]].push([post[0][1], post[1]]);
                });
                for (let pageIndex in store) {
                    let isMatch = false;
                    let seenBadRevision = false;
                    for (let j = 0; j < store[pageIndex].length; j++) {
                        if (store[pageIndex][j][0] === revDate) {
                            // current image is uploaded
                            isMatch = true;
                            break;
                        } else if (store[pageIndex][j][1] && !ignoreBadRevision) {
                            seenBadRevision = true;
                        }
                    }
                    if (isMatch) matchArray.push(true);
                    else if (!seenBadRevision) matchArray.push(false);
                    else matchArray.push("bad revision");
                }
                if (matchArray.includes(false)) thumb.link.setAttribute("style", styleSourceMismatch);
                else if (matchArray.includes("bad revision")) thumb.link.setAttribute("style", styleSourceBadRevision);
                else thumb.link.setAttribute("style", styleSourceFound);
            };

            for (let i = 0; i < thumbList.length; i++) {
                //Collect the IDs of every post with the same pixiv_id/page as the pixiv image
                for (let j = 0; j < result.length; j++) {
                    if (thumbList[i].pixiv_id == result[j].pixiv_id && thumbList[i].posts.indexOf(result[j].id) < 0 && (thumbList[i].page < 0 || thumbList[i].page == pixivPageNumber(result[j].source))) {
                        thumbList[i].link.title = result[j].tag_string + " user:" + result[j].uploader_name + " rating:" + result[j].rating + " score:" + result[j].score;
                        thumbList[i].posts.push({
                            "id": result[j].id,
                            "src": result[j].source,
                            "isBadRevision": result[j].tag_string.split(" ").includes("bad_revision")
                        });
                    }
                }
                if (thumbList[i].posts.length === 1) {
                    //Found one post; link directly to it
                    thumbList[i].link.textContent = "post #" + thumbList[i].posts[0].id;
                    thumbList[i].link.href = danbooruURL + "posts/" + thumbList[i].posts[0].id;
                    setStyleSingle(thumbList[i]);
                } else if (thumbList[i].posts.length > 1) {
                    //Found multiple posts; link to tag search
                    thumbList[i].link.textContent = "(" + thumbList[i].posts.length + " sources)";

                    if (location.href.indexOf("mode=manga") > 0) {
                        // manga display
                        thumbList[i].link.href = danbooruURL + "posts?tags=status:any+id:" + thumbList[i].posts.map(function (post) {
                            return post.id;
                        });
                        setStyleMulti(thumbList[i]);
                    } else {
                        thumbList[i].link.href = danbooruURL + "posts?tags=status:any+pixiv:" + thumbList[i].pixiv_id;
                        setStyleMulti(thumbList[i]);
                    }
                    thumbList[i].link.removeAttribute("title");
                }
            }

            if (result.length === 100)
                sourceSearch(thumbList, attempt + 1, page + 1); //Max results returned, so fetch the next page
            else
                for (let i = 0; i < thumbList.length; i++) {
                    //No more results will be forthcoming; hide the status counter and set the links for the images without any posts
                    thumbList[i].status.style.display = "none";
                    if (thumbList[i].posts.length === 0) {
                        thumbList[i].link.textContent = "(no sources)";
                        thumbList[i].link.setAttribute("style", styleSourceMissing);
                    }
                }
        },
        onerror: retry,
        onabort: retry
    });
}