-- Objective UI audit for Studio MCP execute_luau (Edit or Client datamodel).
-- Send this file's source followed by your own lines, for example:
--   local root = Audit.mount(Vector2.new(844, 390)) -- Edit only: temporary StarterGui.UiAudit
--   require(game.ReplicatedStorage.MyPanel).new(root)  -- build the UI into root
--   return Audit.run(root)                           -- JSON report
-- In Client Play, audit live UI instead:
--   return Audit.run(game.Players.LocalPlayer.PlayerGui.MyHud, { ignore = { "Backdrop" } })
-- Remove the temporary mount when done: Audit.cleanup().
-- Checks every visible GuiObject under root:
--   textOverflow      text that does not fit its own label (TextFits = false)
--   textOutsideParent text whose box extends past its parent GuiObject's box
--   smallTargets      GuiButtons under minTarget pixels (default 44) on either axis
--   outOfBounds       anything outside root that no ScrollingFrame/ClipsDescendants clips
-- options.ignore lists instance names that may legitimately leave root (full-bleed
-- backdrops). On UIScaled guis, minTarget is in pixels: audit at the phone scale.
-- The audit cannot judge taste: always compare screenshots against the spec too.
local Audit = {}

function Audit.mount(size: Vector2): Frame
	Audit.cleanup()
	local gui = Instance.new("ScreenGui")
	gui.Name = "UiAudit"
	gui.IgnoreGuiInset = true
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	local world = Instance.new("Frame")
	world.Size = UDim2.fromScale(1, 1)
	world.BackgroundColor3 = Color3.fromRGB(146, 204, 132)
	world.BorderSizePixel = 0
	world.Parent = gui
	local root = Instance.new("Frame")
	root.Name = "Root"
	root.AnchorPoint = Vector2.new(0.5, 0.5)
	root.Position = UDim2.fromScale(0.5, 0.5)
	root.Size = UDim2.fromOffset(size.X, size.Y)
	root.BackgroundTransparency = 1
	root.Parent = gui
	gui.Parent = game:GetService("StarterGui")
	return root
end

function Audit.cleanup(): string
	local old = game:GetService("StarterGui"):FindFirstChild("UiAudit")
	if old then
		old:Destroy()
	end
	return "cleaned"
end

function Audit.run(
	root: GuiBase2d,
	options: { minTarget: number?, slack: number?, ignore: { string }? }?
): string
	local minTarget = options and options.minTarget or 44
	local slack = options and options.slack or 2
	local ignore = options and options.ignore or {}
	local function shown(item: Instance): boolean
		while item and item ~= root do
			if item:IsA("GuiObject") and not item.Visible then
				return false
			end
			item = item.Parent :: Instance
		end
		return true
	end
	local function clipped(item: Instance): boolean
		local parent = item.Parent
		while parent and parent ~= root do
			if
				parent:IsA("ScrollingFrame")
				or (parent:IsA("GuiObject") and parent.ClipsDescendants)
			then
				return true
			end
			parent = parent.Parent
		end
		return false
	end
	local function outside(a: Vector2, b: Vector2, low: Vector2, high: Vector2): boolean
		return a.X < low.X - slack
			or a.Y < low.Y - slack
			or b.X > high.X + slack
			or b.Y > high.Y + slack
	end
	local counts = {
		guiObjects = 0,
		textOverflow = 0,
		textOutsideParent = 0,
		smallTargets = 0,
		outOfBounds = 0,
	}
	local samples =
		{ textOverflow = {}, textOutsideParent = {}, smallTargets = {}, outOfBounds = {} }
	local function note(kind: string, item: Instance, detail: string)
		counts[kind] += 1
		if #samples[kind] < 8 then
			table.insert(samples[kind], item:GetFullName():sub(-70) .. " " .. detail)
		end
	end
	local low, high = root.AbsolutePosition, root.AbsolutePosition + root.AbsoluteSize
	for _, item in root:GetDescendants() do
		if item:IsA("GuiObject") and shown(item) then
			counts.guiObjects += 1
			local a, b = item.AbsolutePosition, item.AbsolutePosition + item.AbsoluteSize
			local text = item:IsA("TextLabel") or item:IsA("TextButton") or item:IsA("TextBox")
			if text and (item :: any).Text ~= "" then
				if not (item :: any).TextFits then
					note("textOverflow", item, string.format("%q", (item :: any).Text:sub(1, 30)))
				end
				local parent = item.Parent
				if parent and parent:IsA("GuiObject") and not parent:IsA("ScrollingFrame") then
					if
						outside(
							a,
							b,
							parent.AbsolutePosition,
							parent.AbsolutePosition + parent.AbsoluteSize
						)
					then
						note(
							"textOutsideParent",
							item,
							string.format("%q", (item :: any).Text:sub(1, 30))
						)
					end
				end
			end
			if
				item:IsA("GuiButton")
				and (item.AbsoluteSize.X < minTarget - 0.5 or item.AbsoluteSize.Y < minTarget - 0.5)
			then
				note("smallTargets", item, tostring(item.AbsoluteSize))
			end
			if
				not table.find(ignore, item.Name)
				and not clipped(item)
				and outside(a, b, low, high)
			then
				note("outOfBounds", item, tostring(a) .. " .. " .. tostring(b))
			end
		end
	end
	return game:GetService("HttpService"):JSONEncode({ counts = counts, samples = samples })
end
