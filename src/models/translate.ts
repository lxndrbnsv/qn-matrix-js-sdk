export function translate(msg, language) {
    const apiURL = "https://qwertynetworks.com/translateit.php";
    var xhr = new XMLHttpRequest();
    xhr.open("POST", apiURL, false);
    xhr.setRequestHeader("User-Agent", "Cron");
    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    xhr.send(`phrase=${msg}&lng=${language}`);
    return (
        String(xhr.responseText)
    );
}

