package models

// Profile maps to the "blog_profile" table.
type Profile struct {
	ID     int32   `gorm:"primaryKey;autoIncrement"`
	Bio    *string `gorm:"type:text"`
	Avatar *string `gorm:"size:100"`
	UserID int32   `gorm:"not null;unique"`

	User User `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (profiles).
func (Profile) TableName() string {
	return "blog_profile"
}
