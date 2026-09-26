const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5000;

const server = http.createServer((req, res) => {
  // Define the path to your HTML file
  const filePath = path.join(__dirname, 'test.html');

  // Read the HTML file from the disk
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // If there's an error finding or reading the file, send a 500 error
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server Error: Could not read the file.');
      return;
    }

    // Successfully send the HTML content to the browser
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}/`);
});
