//! Browser CVSE client. Each request opens a fresh two-party RPC session over /rpc.
//! The server-side /rpc endpoint MUST bridge binary WebSocket frames to raw TCP bytes;
//! the native relay crate implements that endpoint.
mod transport;
#[allow(non_snake_case)]
mod CVSE_capnp {
    include!(concat!(env!("OUT_DIR"), "/CVSE_capnp.rs"));
}
use capnp_rpc::{rpc_twoparty_capnp, twoparty, RpcSystem};
use serde::Serialize;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use CVSE_capnp::cvse;

type Client = cvse::Client;
type Result<T> = std::result::Result<T, String>;
fn rpc<T>(result: capnp::Result<T>) -> Result<T> {
    result.map_err(|e| e.to_string())
}
fn text(t: capnp::Result<capnp::text::Reader<'_>>) -> Result<String> {
    Ok(rpc(t)?.to_string().map_err(|e| e.to_string())?)
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn boolean(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(default)
}
fn integer(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(default)
}
fn rank(name: &str) -> Result<cvse::rank::RankValue> {
    match name.to_ascii_lowercase().as_str() {
        "domestic" | "0" => Ok(cvse::rank::RankValue::Domestic),
        "sv" | "1" => Ok(cvse::rank::RankValue::Sv),
        "utau" | "2" => Ok(cvse::rank::RankValue::Utau),
        _ => Err(format!("invalid rank: {name}")),
    }
}
fn rank_name(r: cvse::rank::RankValue) -> &'static str {
    match r {
        cvse::rank::RankValue::Domestic => "domestic",
        cvse::rank::RankValue::Sv => "sv",
        cvse::rank::RankValue::Utau => "utau",
    }
}
fn set_rank(mut r: cvse::rank::Builder<'_>, name: &str) -> Result<()> {
    r.set_value(rank(name)?);
    Ok(())
}
fn indices_to_json(
    indices: capnp::struct_list::Reader<'_, cvse::index::Owned>,
) -> Result<Vec<(String, String)>> {
    indices
        .iter()
        .map(|i| Ok((text(i.get_avid())?, text(i.get_bvid())?)))
        .collect()
}
fn set_indices(
    mut list: capnp::struct_list::Builder<'_, cvse::index::Owned>,
    indices: &[(String, String)],
) {
    for (i, (avid, bvid)) in indices.iter().enumerate() {
        let mut entry = list.reborrow().get(i as u32);
        entry.set_avid(avid);
        entry.set_bvid(bvid);
    }
}
fn ranks(meta: cvse::recording_new_entry::Reader<'_>) -> Result<Vec<&'static str>> {
    rpc(meta.get_ranks())?
        .iter()
        .map(|r| Ok(rank_name(r.get_value().map_err(|e| e.to_string())?)))
        .collect()
}
fn local_date(timestamp_ms: f64) -> String {
    let d = js_sys::Date::new(&JsValue::from_f64(timestamp_ms));
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        d.get_full_year(),
        d.get_month() + 1,
        d.get_date(),
        d.get_hours(),
        d.get_minutes(),
        d.get_seconds()
    )
}
fn video(meta: cvse::recording_new_entry::Reader<'_>) -> Result<Value> {
    let when = rpc(meta.get_pubdate())?;
    let seconds = when.get_seconds();
    let tags: Result<Vec<String>> = rpc(meta.get_tags())?.iter().map(text).collect();
    Ok(json!({
        "avid": text(meta.get_avid())?, "bvid": text(meta.get_bvid())?,
        "title": text(meta.get_title())?, "uploader": text(meta.get_uploader())?,
        "up_face": text(meta.get_up_face())?, "cover": text(meta.get_cover())?,
        "pubdate": local_date(seconds as f64 * 1000.0 + when.get_nanoseconds() as f64 / 1e6),
        "pub_timestamp": seconds, "duration": meta.get_duration(), "tags": tags?,
        "desc": text(meta.get_desc())?, "ranks": ranks(meta)?,
        "is_examined": meta.get_is_examined(), "is_republish": meta.get_is_republish(),
        "staff_info": text(meta.get_staff_info())?
    }))
}
fn required_auth(auth: &str) -> Result<&str> {
    if auth.is_empty() {
        Err("auth key required for writes".into())
    } else {
        Ok(auth)
    }
}

async fn get_meta(client: &Client, indices: &[(String, String)]) -> Result<Vec<Value>> {
    if indices.is_empty() {
        return Ok(vec![]);
    }
    let mut request = client.lookup_meta_info_request();
    set_indices(request.get().init_indices(indices.len() as u32), indices);
    let response = rpc(request.send().promise.await)?;
    rpc(response.get().map_err(|e| e))?
        .get_entries()
        .map_err(|e| e.to_string())?
        .iter()
        .map(video)
        .collect()
}
async fn all_ranking(
    client: &Client,
    name: &str,
    index: i32,
    unexamined: bool,
    from: i32,
    to: i32,
) -> Result<Vec<(String, String)>> {
    let mut request = client.get_all_ranking_info_request();
    let mut params = request.get();
    set_rank(params.reborrow().init_rank(), name)?;
    params.set_index(index);
    params.set_contain_unexamined(unexamined);
    params.set_from_rank(from);
    params.set_to_rank(to);
    let response = rpc(request.send().promise.await)?;
    indices_to_json(
        rpc(response.get())?
            .get_entries()
            .map_err(|e| e.to_string())?,
    )
}
async fn ranking_details(
    client: &Client,
    name: &str,
    index: i32,
    unexamined: bool,
    indices: &[(String, String)],
) -> Result<Vec<Value>> {
    if indices.is_empty() {
        return Ok(vec![]);
    }
    let mut request = client.lookup_ranking_info_request();
    let mut p = request.get();
    set_rank(p.reborrow().init_rank(), name)?;
    p.set_index(index);
    p.set_contain_unexamined(unexamined);
    set_indices(p.init_indices(indices.len() as u32), indices);
    let response = rpc(request.send().promise.await)?;
    rpc(response.get())?.get_entries().map_err(|e| e.to_string())?.iter().map(|e| {
        let special = match e.get_special_rank().map_err(|e| e.to_string())? { cvse::ranking_info_entry::SpecialRank::Normal => "normal", cvse::ranking_info_entry::SpecialRank::Sh => "sh", cvse::ranking_info_entry::SpecialRank::Hot => "hot" };
        Ok(json!({"rank": e.get_rank(), "bvid": text(e.get_bvid())?, "avid": text(e.get_avid())?,
            "view": e.get_view(), "like": e.get_like(), "coin": e.get_coin(),
            "favorite": e.get_favorite(), "share": e.get_share(), "reply": e.get_reply(),
            "danmaku": e.get_danmaku(), "specialRank": special, "special_rank": special,
            "totalScore": e.get_total_score(), "isNew": e.get_is_new()}))
    }).collect()
}

const ALPHABET: &[u8] = b"FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
const POSITIONS: [usize; 9] = [8, 7, 0, 5, 1, 3, 2, 4, 6];
fn av_index(number: u64) -> Result<(String, String)> {
    if number == 0 || number >= 1 << 51 {
        return Err("AV号超出有效范围".into());
    }
    let mut digits = [b' '; 9];
    let mut n = ((1u64 << 51) | number) ^ 23442827791579;
    for pos in POSITIONS {
        digits[pos] = ALPHABET[(n % 58) as usize];
        n /= 58;
    }
    Ok((
        format!("av{number}"),
        format!("BV1{}", String::from_utf8_lossy(&digits)),
    ))
}
fn parse_id(id: &str) -> Result<(String, String)> {
    let id = id.trim();
    if let Ok(n) = id
        .to_ascii_lowercase()
        .strip_prefix("av")
        .unwrap_or(id)
        .parse::<u64>()
    {
        return av_index(n);
    }
    let bytes = id.as_bytes();
    if bytes.len() != 12 || !bytes[..2].eq_ignore_ascii_case(b"bv") || bytes[2] != b'1' {
        return Err("请输入完整的 BV号或 AV号".into());
    }
    let mut n = 0u64;
    for pos in POSITIONS.iter().rev() {
        let digit = ALPHABET
            .iter()
            .position(|c| *c == bytes[3 + pos])
            .ok_or("invalid BV id")?;
        n = n
            .checked_mul(58)
            .and_then(|v| v.checked_add(digit as u64))
            .ok_or("invalid BV id")?;
    }
    let av = (n & ((1 << 51) - 1)) ^ 23442827791579;
    if av == 0 || av >= 1 << 51 {
        return Err("invalid BV id".into());
    }
    Ok((format!("av{av}"), format!("BV{}", &id[2..])))
}

async fn videos(client: &Client, p: &Value) -> Result<Value> {
    let date = string(p, "date");
    let date = if date.is_empty() {
        local_date(js_sys::Date::now())[..10].to_owned()
    } else {
        date.to_owned()
    };
    let start = js_sys::Date::new(&JsValue::from_str(&format!("{date}T00:00:00"))).get_time();
    if !start.is_finite() {
        return Err("invalid date; expected YYYY-MM-DD".into());
    }
    let d = js_sys::Date::new(&JsValue::from_f64(start));
    let date_label = format!(
        "{}年{:02}月{:02}日",
        d.get_full_year(),
        d.get_month() + 1,
        d.get_date()
    );
    d.set_date(d.get_date() + 1);
    let end = d.get_time();
    let mut request = client.get_all_request();
    let mut params = request.get();
    let examined = string(p, "examined");
    params.set_get_unexamined(matches!(
        examined,
        "unexamined" | "" | "false" | "no" | "other"
    ));
    params.set_get_unincluded(true);
    let mut from = params.reborrow().init_from_date();
    from.set_seconds((start / 1000.0) as i64);
    from.set_nanoseconds(0);
    let mut to = params.init_to_date();
    to.set_seconds((end / 1000.0) as i64);
    to.set_nanoseconds(0);
    let response = rpc(request.send().promise.await)?;
    let indices = indices_to_json(
        rpc(response.get())?
            .get_indices()
            .map_err(|e| e.to_string())?,
    )?;
    let mut items = get_meta(client, &indices).await?;
    let keyword = string(p, "keyword").to_lowercase();
    let bvid = string(p, "bvid").to_lowercase();
    let avid = string(p, "avid").to_lowercase();
    let filter = string(p, "rank");
    let republish = string(p, "is_republish");
    if !matches!(republish, "" | "true" | "false") {
        return Err("is_republish must be true, false, or empty".into());
    }
    items.retain(|v| {
        let s = |key: &str| string(v, key).to_lowercase();
        let rs = v["ranks"].as_array().expect("ranks array");
        let has = |r: &str| rs.iter().any(|x| x.as_str() == Some(r));
        (keyword.is_empty()
            || ["title", "uploader", "desc"]
                .iter()
                .any(|k| s(k).contains(&keyword))
            || v["tags"].as_array().is_some_and(|tags| {
                tags.iter()
                    .any(|t| t.as_str().unwrap_or("").to_lowercase().contains(&keyword))
            }))
            && s("bvid").contains(&bvid)
            && s("avid").contains(&avid)
            && (filter.is_empty()
                || filter == "all"
                || (filter == "unrecorded" && rs.is_empty())
                || filter.split(',').any(|f| {
                    has(f) || f == "other" && !boolean(v, "is_examined", false) && rs.is_empty()
                }))
            && match examined {
                "yes" | "true" => boolean(v, "is_examined", false) && !rs.is_empty(),
                "no" | "false" => !boolean(v, "is_examined", false),
                "exclusion" => boolean(v, "is_examined", false) && rs.is_empty(),
                "other" => !boolean(v, "is_examined", false) && rs.is_empty(),
                _ => true,
            }
            && (republish.is_empty() || boolean(v, "is_republish", false) == (republish == "true"))
    });
    let count = |pred: &dyn Fn(&Value) -> bool| items.iter().filter(|v| pred(v)).count();
    let has = |v: &Value, r: &str| {
        v["ranks"]
            .as_array()
            .is_some_and(|rs| rs.iter().any(|x| x.as_str() == Some(r)))
    };
    let empty = |v: &Value| v["ranks"].as_array().is_some_and(Vec::is_empty);
    let stats = json!({"total": items.len(), "domestic": count(&|v| has(v, "domestic")), "sv": count(&|v| has(v, "sv")), "utau": count(&|v| has(v, "utau")), "republish": count(&|v| boolean(v, "is_republish", false)), "uncheck": count(&|v| !boolean(v, "is_examined", false)), "exclusion": count(&|v| boolean(v, "is_examined", false) && empty(v)), "other": count(&|v| !boolean(v, "is_examined", false) && empty(v))});
    let page = integer(p, "page", 1).max(1) as usize;
    let size = integer(p, "page_size", 100).max(1) as usize;
    let start = page.saturating_sub(1).saturating_mul(size);
    Ok(
        json!({"success": true, "total": items.len(), "data": items.into_iter().skip(start).take(size).collect::<Vec<_>>(), "stats": stats, "page": page, "page_size": size, "date_range": {"date": date_label}}),
    )
}

async fn preview(client: &Client, p: &Value) -> Result<Value> {
    let name = p.get("rank").and_then(Value::as_str).unwrap_or("domestic");
    rank(name)?;
    let index = integer(p, "index", 1);
    let page = integer(p, "page", 1);
    let size = integer(p, "page_size", 20);
    if index < 1 || index > i32::MAX as i64 || page < 1 || !(1..=120).contains(&size) {
        return Err("invalid index, page or page_size".into());
    }
    let unexamined = boolean(p, "contain_unexamined", true);
    let mut request = client.lookup_ranking_meta_info_request();
    let mut params = request.get();
    set_rank(params.reborrow().init_rank(), name)?;
    params.set_index(index as i32);
    params.set_contain_unexamined(unexamined);
    let unavailable = |e: String| {
        if e.contains("No ranking meta info found") {
            "ranking_unavailable: 该期暂无可读取的已计算榜单".into()
        } else {
            e
        }
    };
    let response = rpc(request.send().promise.await).map_err(unavailable)?;
    let stat = rpc(rpc(response.get())?.get_stat()).map_err(unavailable)?;
    let summary = json!({"count": stat.get_count(), "totalView": stat.get_total_view(), "totalLike": stat.get_total_like(), "totalCoin": stat.get_total_coin(), "totalFavorite": stat.get_total_favorite(), "totalNew": stat.get_total_new()});
    let video_id = string(p, "video_id").trim();
    let search = if video_id.is_empty() {
        None
    } else {
        Some(parse_id(video_id)?)
    };
    let start = (page - 1).saturating_mul(size).saturating_add(1);
    let cursor = integer(p, "cursor_rank", start);
    let offset = integer(p, "cursor_offset", 0);
    if !(1..=2147483646).contains(&cursor) || !(0..=200000).contains(&offset) {
        return Err("invalid cursor".into());
    }
    let raw = if search.is_some() || stat.get_count() == 0 && !boolean(p, "include_special", false)
    {
        vec![]
    } else {
        all_ranking(
            client,
            name,
            index as i32,
            unexamined,
            cursor as i32,
            (cursor + offset + size + 1).min(i32::MAX as i64) as i32,
        )
        .await?
    };
    let indices: Vec<_> = if let Some(id) = search {
        vec![id]
    } else {
        raw.iter()
            .skip(offset as usize)
            .take(size as usize)
            .cloned()
            .collect()
    };
    let mut entries = ranking_details(client, name, index as i32, unexamined, &indices).await?;
    // Detail RPC is unordered and can omit missing indices.
    entries.sort_by_key(|v| {
        indices
            .iter()
            .position(|id| id.1 == string(v, "bvid"))
            .unwrap_or(usize::MAX)
    });
    if !video_id.is_empty() {
        entries.truncate(1);
    }
    let metadata = if entries.is_empty() {
        vec![]
    } else {
        get_meta(client, &indices).await?
    };
    enrich(&mut entries, &metadata);
    let has_next = video_id.is_empty() && raw.len() > offset as usize + size as usize;
    let next_cursor = entries.last().map(|last| {
        let last_rank = integer(last, "rank", 0);
        let consumed = entries.iter().filter(|v| integer(v, "rank", -1) == last_rank).count() as i64;
        json!({"rank": last_rank, "offset": consumed + if last_rank == cursor { offset } else { 0 }})
    });
    let mut special_entries = vec![];
    let mut special_truncated = false;
    if boolean(p, "include_special", false) && video_id.is_empty() {
        let zero = all_ranking(client, name, index as i32, unexamined, 0, 1).await?;
        special_truncated = zero.len() > 100;
        let selected: Vec<_> = zero.into_iter().take(100).collect();
        special_entries =
            ranking_details(client, name, index as i32, unexamined, &selected).await?;
        special_entries.retain(|v| {
            integer(v, "rank", -1) == 0 && matches!(string(v, "specialRank"), "hot" | "sh")
        });
        let meta = get_meta(client, &selected).await?;
        enrich(&mut special_entries, &meta);
    }
    Ok(
        json!({"success": true, "data": {"stat": summary, "entries": entries, "special_entries": special_entries, "special_truncated": special_truncated, "page": page, "page_size": size, "total": stat.get_count(), "search_id": video_id, "has_next": has_next, "next_cursor": next_cursor}}),
    )
}
fn enrich(entries: &mut [Value], metadata: &[Value]) {
    for entry in entries {
        let meta = metadata.iter().find(|m| m["bvid"] == entry["bvid"]);
        for key in ["title", "uploader", "cover"] {
            entry[key] = meta.map(|m| m[key].clone()).unwrap_or(json!(""));
        }
        entry["duration"] = meta.map(|m| m["duration"].clone()).unwrap_or(Value::Null);
        entry["ranks"] = meta.map(|m| m["ranks"].clone()).unwrap_or(json!([]));
        entry["is_examined"] = meta
            .map(|m| m["is_examined"].clone())
            .unwrap_or(json!(false));
    }
}

async fn dispatch(client: &Client, method: &str, p: &Value, auth: &str) -> Result<Value> {
    match method {
        "getVideos" | "videos" => videos(client, p).await,
        "getVideo" | "video" => {
            let id = p.as_str().unwrap_or_else(|| string(p, "bvid"));
            let indices = vec![parse_id(id)?];
            let items = get_meta(client, &indices).await?;
            items
                .into_iter()
                .next()
                .map(|item| json!({"success": true, "data": item}))
                .ok_or("Video not found".into())
        }
        "submitChanges" | "submit-changes" => {
            let changes = p
                .get("changes")
                .and_then(Value::as_array)
                .ok_or("changes array required")?;
            if changes.is_empty() {
                return Err("No changes to submit".into());
            }
            let mut request = client.update_modify_entry_request();
            let mut params = request.get();
            params.set_auth_token(required_auth(auth)?);
            let mut list = params.init_entries(changes.len() as u32);
            for (i, change) in changes.iter().enumerate() {
                let avid = string(change, "avid");
                let bvid = string(change, "bvid");
                if avid.is_empty() || bvid.is_empty() {
                    return Err("Each change must include avid and bvid".into());
                }
                let mut entry = list.reborrow().get(i as u32);
                entry.set_avid(avid);
                entry.set_bvid(bvid);
                if let Some(v) = change["is_examined"].as_bool() {
                    entry.set_has_is_examined(true);
                    entry.set_is_examined(v);
                }
                if let Some(v) = change["is_republish"].as_bool() {
                    entry.set_has_is_republish(true);
                    entry.set_is_republish(v);
                }
                if let Some(v) = change["staff_info"].as_str() {
                    entry.set_has_staff_info(true);
                    entry.set_staff_info(v);
                }
                let ranks = change.get("ranks").filter(|v| !v.is_null());
                if let Some(ranks) = ranks {
                    let ranks = ranks.as_array().ok_or("ranks must be an array or null")?;
                    entry.set_has_ranks(true);
                    let mut list = entry.init_ranks(ranks.len() as u32);
                    for (j, r) in ranks.iter().enumerate() {
                        let name = r
                            .as_str()
                            .map(str::to_owned)
                            .or_else(|| r.as_i64().map(|n| n.to_string()))
                            .ok_or("invalid rank")?;
                        set_rank(list.reborrow().get(j as u32), &name)?;
                    }
                } else {
                    entry.init_ranks(0);
                }
            }
            rpc(request.send().promise.await)?;
            Ok(json!({"success": true, "message": format!("Submitted {} changes", changes.len())}))
        }
        "calculateRankings" | "calculate-rankings" => {
            let name = p.get("rank").and_then(Value::as_str).unwrap_or("domestic");
            let index = integer(p, "index", 0);
            let index = i32::try_from(index).map_err(|_| "invalid index")?;
            let mut request = client.re_calculate_rankings_request();
            let mut params = request.get();
            set_rank(params.reborrow().init_rank(), name)?;
            params.set_index(index);
            params.set_contain_unexamined(boolean(p, "contain_unexamined", true));
            params.set_lock(boolean(p, "lock", false));
            params.set_auth_token(required_auth(auth)?);
            rpc(request.send().promise.await)?;
            Ok(json!({"success": true, "message": format!("Recalculated rankings for {name}")}))
        }
        "getRankingPreview" | "ranking-preview" => preview(client, p).await,
        "validateAuthKey" | "auth/validate" => {
            let key = p.get("auth_key").and_then(Value::as_str).unwrap_or(auth);
            required_auth(key)?;
            let mut request = client.lookup_ranking_meta_info_request();
            let mut params = request.get();
            set_rank(params.reborrow().init_rank(), "utau")?;
            params.set_index(1);
            params.set_contain_unexamined(true);
            // The backend does NOT authenticate read-only RPC methods. This only checks connectivity.
            let _ = request.send().promise.await;
            Ok(
                json!({"success": true, "valid": false, "message": "Read-only RPC cannot validate auth keys; submit a permitted write to verify."}),
            )
        }
        _ => Err(format!("unknown method: {method}")),
    }
}

/// Request one server.py-compatible operation. Params and result are plain JS objects.
/// Errors reject the Promise. `auth` is sent ONLY in write method auth_token fields.
#[wasm_bindgen]
pub async fn request(
    method: String,
    params: JsValue,
    auth: Option<String>,
) -> std::result::Result<JsValue, JsValue> {
    let p: Value =
        serde_wasm_bindgen::from_value(params).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let (reader, writer, socket) = transport::connect().await?;
    let network = twoparty::VatNetwork::new(
        reader,
        writer,
        rpc_twoparty_capnp::Side::Client,
        Default::default(),
    );
    let mut system = RpcSystem::new(Box::new(network), None);
    let client: Client = system.bootstrap(rpc_twoparty_capnp::Side::Server);
    spawn_local(async move {
        let _ = system.await;
    });
    let result = dispatch(&client, &method, &p, auth.as_deref().unwrap_or("")).await;
    drop(socket);
    // The page expects result.data, not the default JS Map's result.get("data").
    result
        .map_err(|e| JsValue::from_str(&e))?
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_reject_invalid() {
        for number in [1, 170001, (1 << 51) - 1] {
            let (av, bv) = av_index(number).unwrap();
            assert_eq!(parse_id(&av).unwrap(), (av.clone(), bv.clone()));
            assert_eq!(parse_id(&bv).unwrap(), (av, bv));
        }
        for invalid in ["0", "av0", "av2251799813685248", "BV1!!!!!!!!!!", "你好"] {
            assert!(parse_id(invalid).is_err(), "{invalid}");
        }
    }
}
