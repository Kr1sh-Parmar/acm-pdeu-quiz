# ACM PDEU QUIZ

A live quiz app that works like Kahoot. The projector shows the question with four coloured options. Phones show only the coloured shapes.

## Run locally
```
npm install
npm start          # http://localhost:3000
```
- Host: `/host`. Upload a CSV, pick the settings, then share the QR code or PIN.
- Players: `/play`, or scan the QR code.

## CSV format
```
question,option1,option2,option3,option4,answer,time
What does ACM stand for?,Association for Computing Machinery,Advanced Computer Methods,American Coding Ministry,Applied Circuit Mechanics,1,20
HTTP is a stateless protocol.,True,False,,,1,10
```
- `answer` can be 1–4, A–D or the exact option text.
- `option3` and `option4` are optional.
- `time` is optional. Leave it empty to use the default time.
- See `public/sample.csv`.

## Scoring
A correct answer earns 500–1000 points. Faster answers earn more. A wrong answer or no answer earns 0.

## Deploy on Render (free)
1. Push this folder to a GitHub repo.
2. On Render, choose **New → Blueprint** and pick the repo. It reads `render.yaml` automatically.
3. The free tier sleeps after about 15 minutes of no traffic. Open the site a minute before the workshop.

Run only **one instance**. Game state is kept in memory.

## Load test before the workshop
```
node scripts/load-test.js https://your-app.onrender.com 150          # 150 bots play a full game and the script checks the results
node scripts/load-test.js https://your-app.onrender.com 150 123456   # 150 bots join your live game with PIN 123456
```

## Host tips
- Press the **→**, **PageDown** or **Space** key, or click a presenter remote, to go to the next screen.
- Click a nickname in the lobby to remove that player.
- If you refresh the host page, it reconnects to the same game. Players reconnect the same way.
