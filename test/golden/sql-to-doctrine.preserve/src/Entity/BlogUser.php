<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_user')]
class BlogUser
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    /** @var Collection<int, BlogPost> */
    #[ORM\OneToMany(targetEntity: BlogPost::class, mappedBy: 'author')]
    private Collection $author_blog_posts;

    /** @var Collection<int, BlogPost> */
    #[ORM\OneToMany(targetEntity: BlogPost::class, mappedBy: 'editor')]
    private Collection $editor_blog_posts;

    #[ORM\OneToOne(targetEntity: BlogProfile::class, mappedBy: 'user')]
    private ?BlogProfile $blog_profile = null;

    public function __construct()
    {
        $this->author_blog_posts = new ArrayCollection();
        $this->editor_blog_posts = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getAuthorBlogPosts(): Collection
    {
        return $this->author_blog_posts;
    }

    public function addAuthorBlogPost(BlogPost $authorBlogPost): static
    {
        if (!$this->author_blog_posts->contains($authorBlogPost)) {
            $this->author_blog_posts->add($authorBlogPost);
            $authorBlogPost->setAuthor($this);
        }

        return $this;
    }

    public function removeAuthorBlogPost(BlogPost $authorBlogPost): static
    {
        if ($this->author_blog_posts->removeElement($authorBlogPost)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }

    /**
     * @return Collection<int, BlogPost>
     */
    public function getEditorBlogPosts(): Collection
    {
        return $this->editor_blog_posts;
    }

    public function addEditorBlogPost(BlogPost $editorBlogPost): static
    {
        if (!$this->editor_blog_posts->contains($editorBlogPost)) {
            $this->editor_blog_posts->add($editorBlogPost);
            $editorBlogPost->setEditor($this);
        }

        return $this;
    }

    public function removeEditorBlogPost(BlogPost $editorBlogPost): static
    {
        if ($this->editor_blog_posts->removeElement($editorBlogPost)) {
            if ($editorBlogPost->getEditor() === $this) {
                $editorBlogPost->setEditor(null);
            }
        }

        return $this;
    }

    public function getBlogProfile(): ?BlogProfile
    {
        return $this->blog_profile;
    }

    public function setBlogProfile(?BlogProfile $blogProfile): static
    {
        $this->blog_profile = $blogProfile;
        if ($blogProfile !== null) {
            $blogProfile->setUser($this);
        }

        return $this;
    }
}
