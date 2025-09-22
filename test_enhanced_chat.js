// Test script for enhanced local_chat functionality
const { spawn } = require('child_process');

// Start the MCP server
const server = spawn('node', ['dist/server.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

// Test the enhanced local_chat with request tracking
const testRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "local_chat",
    arguments: {
      prompt: "Write a simple Python function to calculate fibonacci numbers",
      track_request: true,
      max_tokens: 1000,
      timeout_ms: 60000
    }
  }
};

// Send test request
server.stdin.write(JSON.stringify(testRequest) + '\n');

// Handle responses
server.stdout.on('data', (data) => {
  const response = JSON.parse(data.toString());
  console.log('Response:', JSON.stringify(response, null, 2));
  
  // If we got a request_id, test the status check
  if (response.result?.structuredContent?.request_id) {
    const statusRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "chat_status",
        arguments: {
          request_id: response.result.structuredContent.request_id
        }
      }
    };
    
    setTimeout(() => {
      server.stdin.write(JSON.stringify(statusRequest) + '\n');
    }, 1000);
  }
});

server.stderr.on('data', (data) => {
  console.error('Server error:', data.toString());
});

// Clean up after 30 seconds
setTimeout(() => {
  server.kill();
  console.log('Test completed');
}, 30000);
