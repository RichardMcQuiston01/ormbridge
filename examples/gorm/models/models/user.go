package models

// User maps to the "auth_user" table.
type User struct {
	ID int32 `gorm:"primaryKey;autoIncrement"`

	Posts       []Post   `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	EditedPosts []Post   `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	Profile     *Profile `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (users).
func (User) TableName() string {
	return "auth_user"
}
