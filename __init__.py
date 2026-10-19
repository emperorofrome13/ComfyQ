from .server import register_routes


# comfyQ adds browser tools and backend routes only. An empty NODE_CLASS_MAPPINGS is the
# loading contract every ComfyUI version understands; the server exists before custom nodes load.
WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes()


__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
