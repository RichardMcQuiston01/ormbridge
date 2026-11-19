// Persistence checks for the canonical blog schema converted from Django to
// GORM for SQLite. The tests copy this file next to validate-gorm.go (as
// main.go) and rewrite the models import path to the scratch module's. It is
// not part of any Go module in this repository.
package main

import (
	"errors"
	"fmt"

	"gormcheck/models"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

func init() {
	extraChecks = blogChecks
}

func expect(condition bool, message string) error {
	if !condition {
		return errors.New(message)
	}
	return nil
}

func blogChecks(db *gorm.DB) error {
	author := models.User{}
	if err := db.Create(&author).Error; err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	root := models.Category{Name: "root", Slug: "root"}
	if err := db.Create(&root).Error; err != nil {
		return fmt.Errorf("create category: %w", err)
	}
	child := models.Category{Name: "child", Slug: "child", ParentID: &root.ID}
	if err := db.Create(&child).Error; err != nil {
		return fmt.Errorf("create child category: %w", err)
	}

	rating := decimal.RequireFromString("3.50")
	post := models.Post{
		Title:      "Hello",
		AuthorID:   author.ID,
		CategoryID: child.ID,
		Rating:     &rating,
		Metadata:   datatypes.JSON(`{"a":1}`),
		Tags:       []models.Tag{{Label: "go"}, {Label: "orm"}},
	}
	if err := db.Create(&post).Error; err != nil {
		return fmt.Errorf("create post: %w", err)
	}
	if err := expect(post.PublicID != uuid.Nil, "BeforeCreate did not fill PublicID"); err != nil {
		return err
	}
	if err := db.Create(&models.Profile{UserID: author.ID}).Error; err != nil {
		return fmt.Errorf("create profile: %w", err)
	}

	var loaded models.Post
	err := db.Preload("Author").Preload("Category").Preload("Tags").First(&loaded, post.ID).Error
	if err != nil {
		return fmt.Errorf("load post: %w", err)
	}
	for _, check := range []struct {
		ok      bool
		message string
	}{
		{loaded.Status == models.PostStatusDraft, "status default is not draft"},
		{loaded.Author.ID == author.ID, "author did not load"},
		{loaded.Category.ID == child.ID, "category did not load"},
		{len(loaded.Tags) == 2, "tags did not load"},
		{loaded.Rating != nil && loaded.Rating.Equal(rating), "rating did not round trip"},
		{loaded.PublicID == post.PublicID, "public id did not round trip"},
		{!loaded.CreatedAt.IsZero() && !loaded.UpdatedAt.IsZero(), "timestamps were not set"},
		{string(loaded.Metadata) == `{"a":1}`, "json did not round trip"},
		{loaded.EditorID == nil, "editor should be null"},
	} {
		if err := expect(check.ok, check.message); err != nil {
			return err
		}
	}

	var user models.User
	if err := db.Preload("Posts").Preload("Profile").First(&user, author.ID).Error; err != nil {
		return fmt.Errorf("load user: %w", err)
	}
	if err := expect(len(user.Posts) == 1 && user.Profile != nil, "reverse relations did not load"); err != nil {
		return err
	}
	var tag models.Tag
	if err := db.Preload("Posts").First(&tag, "label = ?", "go").Error; err != nil {
		return fmt.Errorf("load tag: %w", err)
	}
	if err := expect(len(tag.Posts) == 1, "many-to-many reverse side did not load"); err != nil {
		return err
	}
	var parent models.Category
	if err := db.Preload("Children").Preload("Posts").First(&parent, root.ID).Error; err != nil {
		return fmt.Errorf("load category: %w", err)
	}
	if err := expect(len(parent.Children) == 1, "children did not load"); err != nil {
		return err
	}

	duplicate := models.Post{Title: "Hello", AuthorID: author.ID, CategoryID: child.ID}
	if err := db.Create(&duplicate).Error; err == nil {
		return errors.New("unique (author, title) was not enforced")
	}
	if err := db.Delete(&root).Error; err != nil {
		return fmt.Errorf("delete parent category: %w", err)
	}
	var orphan models.Category
	if err := db.First(&orphan, child.ID).Error; err != nil || orphan.ParentID != nil {
		return errors.New("ON DELETE SET NULL did not clear parent_id")
	}
	if err := db.Delete(&child).Error; err == nil {
		return errors.New("ON DELETE RESTRICT did not protect a category with posts")
	}
	if err := db.Delete(&author).Error; err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	var remaining int64
	db.Model(&models.Post{}).Count(&remaining)
	var links int64
	db.Table("blog_post_tags").Count(&links)
	return expect(remaining == 0 && links == 0, "ON DELETE CASCADE did not remove the posts and their tag links")
}
