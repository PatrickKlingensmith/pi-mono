# Dockerfile

# Use Nginx as the web server since we are hosting static HTML/CSS/JS
FROM nginx:alpine

# Remove the default index page
RUN rm -rf /usr/share/nginx/html/*

# Copy the entire deosite2 directory contents into Nginx's web root
# This assumes the docker build context is the parent directory of deosite2
COPY deosite2/ /usr/share/nginx/html/

# Expose port 80
EXPOSE 80

# Nginx starts by default and handles serving static files
CMD ["nginx", "-g", "daemon off;"]