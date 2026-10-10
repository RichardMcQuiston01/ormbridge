package models

// BlogProfile maps to the "blog_profile" table.
type BlogProfile struct {
	ID     int32   `gorm:"primaryKey;autoIncrement"`
	Bio    *string `gorm:"type:text"`
	Avatar *string `gorm:"size:100"`
	UserID int32   `gorm:"not null;unique"`

	User BlogUser `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (blog_profiles).
func (BlogProfile) TableName() string {
	return "blog_profile"
}
